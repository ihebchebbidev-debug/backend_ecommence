// Full automatic test suite for the Node.js backend.
//
//   DATABASE_URL=postgres://... node scripts/test-all.js
//   node scripts/test-all.js --only=rest        (filter by group name)
//
// Covers: boot auto-migration, schema drift healing, request-time table/column
// auto-creation, health, auth, REST (filters, ordering, paging, count, upsert,
// embeds, single-object, error envelopes), permission rules, every RPC in the
// registry, storage, edge-function auth matrix, realtime and logging.
import { WebSocket } from 'ws';
import { server, bootstrap } from '../src/server.js';
import { pool } from '../src/db.js';
import { signApiKey } from '../src/lib/jwt.js';
import { rpcRegistry } from '../src/rpc/index.js';
import { edgeFunctions } from '../src/functions/index.js';
import { expectedSchema, schemaDrift } from '../src/db/schemaModel.js';

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const ANON = process.env.ANON_KEY || signApiKey('anon');
const SERVICE = process.env.SERVICE_ROLE_KEY || signApiKey('service_role');

// ── tiny test harness ────────────────────────────────────────────────
const results = [];
let group = 'general';
const GROUP = (name) => { group = name; console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`); };

async function test(name, fn) {
  if (ONLY && group !== ONLY) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ group, name, ok: true, ms: Date.now() - started });
    console.log(`  ok   ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ group, name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  FAIL ${name} — ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (actual, expected, label = '') =>
  assert(actual === expected, `${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── http helper ──────────────────────────────────────────────────────
const base = await new Promise((resolve) => {
  server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
});

async function call(path, { method = 'GET', token = ANON, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      apikey: ANON,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const email = `test+${Date.now()}@example.com`;
const password = 'secret123';
const created = { storeId: null, userId: null, userToken: null, refresh: null, productIds: [] };
const scratchTables = [];

// ═════════════════════════════════════════════════════════════════════
GROUP('migration');

await test('bootstrap applies schema and reports up to date', async () => {
  const report = await bootstrap({ force: true });
  assert(report, 'no migration report');
  assert(report.upToDate, `drift remains: ${JSON.stringify(report.stillMissingTables)} ${JSON.stringify(report.stillMissingColumns)}`);
  assert(report.expectedTables >= 70, `expected >=70 declared tables, got ${report.expectedTables}`);
});

await test('migration ledger records applied files', async () => {
  const { rows } = await pool.query(`SELECT DISTINCT name FROM public._schema_migrations WHERE kind = 'file'`);
  const names = rows.map((r) => r.name);
  for (const f of ['schema.sql', 'auth_schema.sql', 'realtime.sql']) assert(names.includes(f), `${f} not recorded`);
});

await test('re-running bootstrap is a no-op (idempotent)', async () => {
  const report = await bootstrap({ force: true });
  eq(report.filesApplied.length, 0, 'files re-applied:');
  eq(report.tablesCreated.length, 0, 'tables re-created:');
  eq(report.columnsAdded.length, 0, 'columns re-added:');
});

await test('a dropped column is detected as drift and restored on boot', async () => {
  await pool.query('ALTER TABLE public.activity_log DROP COLUMN IF EXISTS user_name');
  const before = await schemaDrift();
  assert(before.missingColumns.some((c) => c.table === 'activity_log' && c.name === 'user_name'), 'drift not detected');
  const report = await bootstrap({ force: true });
  assert(report.columnsAdded.includes('public.activity_log.user_name'), `not restored: ${JSON.stringify(report.columnsAdded)}`);
  const after = await schemaDrift();
  eq(after.missingColumns.length, 0, 'columns still missing:');
});

await test('a dropped table is recreated on boot', async () => {
  await pool.query('DROP TABLE IF EXISTS public.activity_log CASCADE');
  const report = await bootstrap({ force: true });
  assert(report.tablesCreated.includes('public.activity_log'), `not recreated: ${JSON.stringify(report.tablesCreated)}`);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM information_schema.columns WHERE table_name='activity_log'`);
  eq(rows[0].c, Object.keys(expectedSchema().get('public.activity_log').columns).length, 'column count:');
});

await test('GET /health/schema reports a healthy schema', async () => {
  const res = await call('/health/schema', { token: SERVICE });
  eq(res.status, 200);
  assert(res.body.upToDate === true, JSON.stringify(res.body));
  assert(res.body.liveTables >= 70, `liveTables ${res.body.liveTables}`);
});

// ═════════════════════════════════════════════════════════════════════
GROUP('health');

await test('GET /health', async () => {
  const res = await call('/health');
  eq(res.status, 200);
  eq(res.body.db, 'up');
});

await test('every response carries a request id', async () => {
  const res = await call('/health');
  assert(res.headers.get('x-request-id'), 'missing x-request-id');
});

await test('an unknown route returns the PostgREST error envelope', async () => {
  const res = await call('/definitely/not/here');
  eq(res.status, 404);
  assert('message' in res.body && 'code' in res.body && 'details' in res.body && 'hint' in res.body, JSON.stringify(res.body));
});

// ═════════════════════════════════════════════════════════════════════
GROUP('docs');

await test('GET / serves the interactive API explorer', async () => {
  const res = await call('/', { token: null });
  eq(res.status, 200);
  assert(String(res.body).includes('swagger'), 'explorer html not served');
});

await test('GET /openapi.json is a valid spec covering every surface', async () => {
  const res = await call('/openapi.json', { token: null });
  eq(res.status, 200);
  const spec = res.body;
  eq(spec.openapi, '3.0.3');
  for (const p of ['/health', '/auth/v1/token', '/rest/v1/{table}', '/rest/v1/rpc/{fn}',
    '/functions/v1/{name}', '/storage/v1/object/{bucket}/{path}']) {
    assert(spec.paths[p], `missing path ${p}`);
  }
  assert(spec.components.securitySchemes.bearerAuth, 'no bearer auth scheme');
});

await test('the spec lists every table, database function and server function', async () => {
  const spec = (await call('/openapi.json', { token: null })).body;
  const tables = spec.paths['/rest/v1/{table}'].get.parameters.find((p) => p.name === 'table').schema.enum;
  const declared = [...expectedSchema().values()].filter((t) => t.schema === 'public' && !t.table.startsWith('_')).length;
  eq(tables.length, declared, 'tables in spec:');
  eq(spec.paths['/rest/v1/rpc/{fn}'].post.parameters[0].schema.enum.length, Object.keys(rpcRegistry).length, 'rpcs in spec:');
  eq(spec.paths['/functions/v1/{name}'].post.parameters[0].schema.enum.length, Object.keys(edgeFunctions).length, 'functions in spec:');
});

await test('the docs never shadow a real endpoint', async () => {
  eq((await call('/health')).status, 200);
  eq((await call('/rest/v1/profiles', { token: SERVICE })).status, 200);
});

// ═════════════════════════════════════════════════════════════════════
GROUP('auth');

await test('signup returns a session', async () => {
  const res = await call('/auth/v1/signup', { method: 'POST', body: { email, password, data: { full_name: 'Test User' } } });
  eq(res.status, 200);
  // GoTrue shape: the token response is FLAT, with the user nested under `user`.
  assert(res.body?.access_token, JSON.stringify(res.body));
  created.userId = res.body.user.id;
  created.userToken = res.body.access_token;
  created.refresh = res.body.refresh_token;
});

await test('signup creates the profile row', async () => {
  const { rows } = await pool.query('SELECT status, deleted_at, suspended_at FROM public.profiles WHERE id = $1', [created.userId]);
  eq(rows.length, 1, 'profile rows:');
  eq(rows[0].status, 'active');
  eq(rows[0].deleted_at, null);
  eq(rows[0].suspended_at, null);
});

await test('duplicate signup is rejected', async () => {
  const res = await call('/auth/v1/signup', { method: 'POST', body: { email, password } });
  eq(res.status, 422);
});

await test('password grant works', async () => {
  const res = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  eq(res.status, 200);
  assert(res.body.access_token, JSON.stringify(res.body));
});

await test('wrong password is rejected', async () => {
  const res = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'nope' } });
  eq(res.status, 400);
});

await test('unknown email is rejected', async () => {
  const res = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'nobody@example.com', password } });
  eq(res.status, 400);
});

await test('refresh token grant works', async () => {
  const res = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: created.refresh } });
  eq(res.status, 200);
  assert(res.body.access_token, JSON.stringify(res.body));
});

await test('an invalid refresh token is rejected', async () => {
  const res = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: 'garbage' } });
  assert(res.status >= 400, `status ${res.status}`);
});

await test('GET /auth/v1/user returns the caller', async () => {
  const res = await call('/auth/v1/user', { token: created.userToken });
  eq(res.status, 200);
  eq(res.body.email, email);
});

await test('GET /auth/v1/user without a session is rejected', async () => {
  const res = await call('/auth/v1/user', { token: null });
  eq(res.status, 401);
});

await test('an unparseable bearer token is rejected', async () => {
  const res = await call('/rest/v1/profiles', { token: 'not-a-jwt' });
  eq(res.status, 401);
});

await test('recover and resend do not leak account existence', async () => {
  const a = await call('/auth/v1/recover', { method: 'POST', body: { email } });
  const b = await call('/auth/v1/recover', { method: 'POST', body: { email: 'ghost@example.com' } });
  eq(a.status, b.status, 'recover status differs:');
});

// ═════════════════════════════════════════════════════════════════════
GROUP('rest');

await test('read own profile row', async () => {
  const res = await call(`/rest/v1/profiles?id=eq.${created.userId}&select=id,email,full_name`, { token: created.userToken });
  eq(res.status, 200);
  eq(res.body[0].email, email);
});

await test('create a store owned by the caller', async () => {
  const res = await call('/rest/v1/platform_stores', {
    method: 'POST',
    token: created.userToken,
    body: { slug: `test-${Date.now()}`, store_name: 'Test Store', user_id: created.userId },
    headers: { prefer: 'return=representation' },
  });
  eq(res.status, 201);
  assert(res.body[0]?.id, JSON.stringify(res.body));
  created.storeId = res.body[0].id;
});

await test('cannot create a store owned by somebody else', async () => {
  const res = await call('/rest/v1/platform_stores', {
    method: 'POST',
    token: created.userToken,
    body: { slug: `steal-${Date.now()}`, store_name: 'Not Mine', user_id: '00000000-0000-0000-0000-000000000001' },
  });
  eq(res.status, 403);
});

await test('patch the store', async () => {
  const res = await call(`/rest/v1/platform_stores?id=eq.${created.storeId}`, {
    method: 'PATCH', token: created.userToken, body: { store_name: 'Renamed' }, headers: { prefer: 'return=representation' },
  });
  eq(res.status, 200);
  eq(res.body[0].store_name, 'Renamed');
});

await test('patch without a filter is refused', async () => {
  const res = await call('/rest/v1/platform_stores', { method: 'PATCH', token: created.userToken, body: { store_name: 'x' } });
  eq(res.status, 400);
  eq(res.body.code, 'PGRST109');
});

await test('delete without a filter is refused', async () => {
  const res = await call('/rest/v1/products', { method: 'DELETE', token: created.userToken });
  eq(res.status, 400);
  eq(res.body.code, 'PGRST109');
});

await test('insert products in bulk', async () => {
  const res = await call('/rest/v1/products', {
    method: 'POST', token: created.userToken,
    body: [
      { store_id: created.storeId, name: 'Alpha', price: 10 },
      { store_id: created.storeId, name: 'Beta', price: 20.5 },
      { store_id: created.storeId, name: 'Gamma', price: 30 },
    ],
    headers: { prefer: 'return=representation' },
  });
  eq(res.status, 201);
  eq(res.body.length, 3, 'inserted rows:');
  created.productIds = res.body.map((r) => r.id);
});

await test('numeric columns come back as numbers', async () => {
  const res = await call(`/rest/v1/products?store_id=eq.${created.storeId}&name=eq.Beta&select=price`, { token: created.userToken });
  eq(typeof res.body[0].price, 'number');
  eq(res.body[0].price, 20.5);
});

await test('filters: eq, neq, gt, gte, lt, in, like, ilike, is', async () => {
  const t = created.userToken;
  const s = created.storeId;
  const g = async (qs) => (await call(`/rest/v1/products?store_id=eq.${s}&${qs}`, { token: t })).body;
  eq((await g('name=eq.Alpha')).length, 1, 'eq:');
  eq((await g('name=neq.Alpha')).length, 2, 'neq:');
  eq((await g('price=gt.15')).length, 2, 'gt:');
  eq((await g('price=gte.20.5')).length, 2, 'gte:');
  eq((await g('price=lt.15')).length, 1, 'lt:');
  eq((await g('name=in.(Alpha,Gamma)')).length, 2, 'in:');
  eq((await g('name=like.A*')).length, 1, 'like:');
  eq((await g('name=ilike.*eta')).length, 1, 'ilike:');
  eq((await g('description=is.null')).length, 3, 'is.null:');
});

await test('order, limit and offset', async () => {
  const res = await call(`/rest/v1/products?store_id=eq.${created.storeId}&select=name&order=price.desc&limit=2`, { token: created.userToken });
  eq(res.body.length, 2, 'limit:');
  eq(res.body[0].name, 'Gamma', 'order desc:');
  const off = await call(`/rest/v1/products?store_id=eq.${created.storeId}&select=name&order=price.asc&limit=1&offset=1`, { token: created.userToken });
  eq(off.body[0].name, 'Beta', 'offset:');
});

await test('Range header paginates and reports Content-Range', async () => {
  const res = await call(`/rest/v1/products?store_id=eq.${created.storeId}&select=id&order=price.asc`, {
    token: created.userToken, headers: { range: '0-1' },
  });
  eq(res.body.length, 2, 'range rows:');
  assert(/\/3$/.test(res.headers.get('content-range') || ''), `content-range ${res.headers.get('content-range')}`);
});

await test('Prefer: count=exact returns the total', async () => {
  const res = await call(`/rest/v1/products?store_id=eq.${created.storeId}&select=id`, {
    token: created.userToken, headers: { prefer: 'count=exact' },
  });
  eq(res.headers.get('content-range'), '0-2/3');
});

await test('single-object Accept header returns an object', async () => {
  const res = await call(`/rest/v1/products?id=eq.${created.productIds[0]}&select=name`, {
    token: created.userToken, headers: { accept: 'application/vnd.pgrst.object+json' },
  });
  eq(res.status, 200);
  eq(res.body.name, 'Alpha');
});

await test('single-object with many rows returns 406 PGRST116', async () => {
  const res = await call(`/rest/v1/products?store_id=eq.${created.storeId}&select=name`, {
    token: created.userToken, headers: { accept: 'application/vnd.pgrst.object+json' },
  });
  eq(res.status, 406);
  eq(res.body.code, 'PGRST116');
});

await test('Prefer: return=minimal gives 201 with no body', async () => {
  const res = await call('/rest/v1/products', {
    method: 'POST', token: created.userToken,
    body: { store_id: created.storeId, name: 'Minimal', price: 1 },
  });
  eq(res.status, 201);
  assert(!res.body, `body ${JSON.stringify(res.body)}`);
  await call(`/rest/v1/products?store_id=eq.${created.storeId}&name=eq.Minimal`, { method: 'DELETE', token: created.userToken });
});

await test('upsert with merge-duplicates', async () => {
  const id = created.productIds[0];
  const res = await call('/rest/v1/products?on_conflict=id', {
    method: 'POST', token: created.userToken,
    body: { id, store_id: created.storeId, name: 'Alpha upserted', price: 11 },
    headers: { prefer: 'return=representation,resolution=merge-duplicates' },
  });
  eq(res.status, 201);
  eq(res.body[0].name, 'Alpha upserted');
});

await test('anonymous storefront read is scoped to one store', async () => {
  const res = await call(`/rest/v1/products?store_id=eq.${created.storeId}&select=id,name`, { token: null });
  eq(res.status, 200);
  assert(res.body.length >= 3, `rows ${res.body.length}`);
  const unscoped = await call('/rest/v1/products?select=id', { token: null });
  assert(unscoped.status >= 400, `unscoped read allowed: ${unscoped.status}`);
});

await test('anonymous cannot list profiles', async () => {
  const res = await call('/rest/v1/profiles?select=*', { token: null });
  assert(res.status >= 400 || (Array.isArray(res.body) && res.body.length === 0), `status ${res.status}`);
});

await test('denied tables are never reachable', async () => {
  for (const t of ['phone_otp_codes', 'delivery_integration_secrets', 'agent_sessions']) {
    const res = await call(`/rest/v1/${t}?select=*`, { token: created.userToken });
    assert(res.status >= 400, `${t} readable (${res.status})`);
  }
});

await test('admin-only tables refuse a normal session', async () => {
  const res = await call('/rest/v1/admin_audit_logs?select=*', { token: created.userToken });
  eq(res.status, 403);
});

await test('another store\'s rows are invisible', async () => {
  const other = await call('/rest/v1/platform_stores', {
    method: 'POST', token: SERVICE,
    body: { id: crypto.randomUUID(), slug: `other-${Date.now()}`, store_name: 'Other', user_id: crypto.randomUUID(), status: 'active' },
    headers: { prefer: 'return=representation' },
  });
  const otherId = other.body?.[0]?.id;
  assert(otherId, JSON.stringify(other.body));
  const res = await call(`/rest/v1/platform_stores?id=eq.${otherId}&select=id`, { token: created.userToken });
  eq(res.body.length, 0, 'leaked rows:');
  await pool.query('DELETE FROM public.platform_stores WHERE id = $1', [otherId]);
});

await test('unknown table returns 42P01', async () => {
  const res = await call('/rest/v1/table_that_will_never_exist?select=*', { token: created.userToken });
  eq(res.status, 404);
  eq(res.body.code, '42P01');
});

await test('unknown column returns a 400 error envelope', async () => {
  const res = await call('/rest/v1/products?select=not_a_real_column', { token: created.userToken });
  assert(res.status === 400 || res.status === 404, `status ${res.status}`);
  assert(res.body.message, JSON.stringify(res.body));
});

await test('service role reads any table', async () => {
  const res = await call('/rest/v1/phone_otp_codes?select=id&limit=1', { token: SERVICE });
  eq(res.status, 200);
});

// ═════════════════════════════════════════════════════════════════════
GROUP('autoschema');

await test('a new attribute on an existing table creates its column', async () => {
  await pool.query('ALTER TABLE public.products DROP COLUMN IF EXISTS test_autocol');
  const res = await call('/rest/v1/products', {
    method: 'POST', token: created.userToken,
    body: { store_id: created.storeId, name: 'AutoCol', price: 5, test_autocol: 'hello' },
    headers: { prefer: 'return=representation' },
  });
  eq(res.status, 201);
  eq(res.body[0].test_autocol, 'hello');
  const { rows } = await pool.query(
    `SELECT data_type FROM information_schema.columns WHERE table_name='products' AND column_name='test_autocol'`);
  eq(rows[0]?.data_type, 'text');
});

await test('column types are inferred from the value', async () => {
  const res = await call('/rest/v1/products', {
    method: 'POST', token: created.userToken,
    body: {
      store_id: created.storeId, name: 'AutoTypes', price: 6,
      auto_flag: true, auto_count: 7, auto_amount: 1.5, auto_meta: { a: 1 }, auto_when: '2026-01-02T03:04:05Z',
    },
    headers: { prefer: 'return=representation' },
  });
  eq(res.status, 201);
  const { rows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='products' AND column_name LIKE 'auto_%'`);
  const types = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
  eq(types.auto_flag, 'boolean');
  eq(types.auto_count, 'bigint');
  eq(types.auto_amount, 'numeric');
  eq(types.auto_meta, 'jsonb');
  eq(types.auto_when, 'timestamp with time zone');
});

await test('a patch with a new attribute creates its column', async () => {
  const res = await call(`/rest/v1/products?id=eq.${created.productIds[1]}`, {
    method: 'PATCH', token: created.userToken, body: { patch_autocol: 42 },
    headers: { prefer: 'return=representation' },
  });
  eq(res.status, 200);
  eq(res.body[0].patch_autocol, 42);
});

await test('auto-created columns are nullable so existing rows survive', async () => {
  const { rows } = await pool.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name='products' AND column_name='test_autocol'`);
  eq(rows[0].is_nullable, 'YES');
});

await test('the service role can create a table that does not exist yet', async () => {
  const table = `auto_test_${Date.now()}`;
  scratchTables.push(table);
  const res = await call(`/rest/v1/${table}`, {
    method: 'POST', token: SERVICE,
    body: { user_id: created.userId, label: 'first row', qty: 3 },
    headers: { prefer: 'return=representation' },
  });
  eq(res.status, 201);
  eq(res.body[0].label, 'first row');
  const read = await call(`/rest/v1/${table}?select=label,qty`, { token: SERVICE });
  eq(read.body[0].qty, 3);
});

await test('a normal session cannot invent a table', async () => {
  const res = await call(`/rest/v1/nope_${Date.now()}`, {
    method: 'POST', token: created.userToken, body: { user_id: created.userId, x: 1 },
  });
  eq(res.status, 404);
  eq(res.body.code, '42P01');
});

await test('a declared table dropped at runtime is healed on the next request', async () => {
  await pool.query('DROP TABLE IF EXISTS public.activity_log CASCADE');
  const res = await call('/rest/v1/activity_log?select=id&limit=1', { token: SERVICE });
  eq(res.status, 200);
  const { rows } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='activity_log'`);
  eq(rows.length, 1, 'table not healed:');
});

await test('every schema change is written to the ledger', async () => {
  const { rows } = await pool.query(`SELECT name, statement FROM public._schema_migrations WHERE kind = 'auto'`);
  assert(rows.some((r) => r.name.includes('products.test_autocol')), 'auto column not recorded');
  assert(rows.every((r) => r.statement), 'ledger row without SQL');
});

await test('illegal identifiers are never turned into DDL', async () => {
  const res = await call('/rest/v1/products', {
    method: 'POST', token: created.userToken,
    body: { store_id: created.storeId, name: 'Bad', price: 1, 'drop table products; --': 'x' },
  });
  assert(res.status >= 400, `status ${res.status}`);
  const { rows } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='products'`);
  eq(rows.length, 1, 'products table survived:');
});

// ═════════════════════════════════════════════════════════════════════
GROUP('rpc');

await test('unknown RPC returns PGRST202', async () => {
  const res = await call('/rest/v1/rpc/definitely_not_a_function', { method: 'POST', token: created.userToken, body: {} });
  eq(res.status, 404);
  eq(res.body.code, 'PGRST202');
});

await test('is_active_user is true for the new account', async () => {
  const res = await call('/rest/v1/rpc/is_active_user', { method: 'POST', token: created.userToken, body: {} });
  eq(res.status, 200);
  eq(res.body, true);
});

await test('user_store_ids includes the new store', async () => {
  const res = await call('/rest/v1/rpc/user_store_ids', { method: 'POST', token: created.userToken, body: {} });
  eq(res.status, 200);
  assert(JSON.stringify(res.body).includes(created.storeId), JSON.stringify(res.body));
});

await test('is_super_admin is false for the new account', async () => {
  const res = await call('/rest/v1/rpc/is_super_admin', { method: 'POST', token: created.userToken, body: {} });
  eq(res.body, false);
});

await test('every registered RPC is reachable and never crashes the server', async () => {
  const names = Object.keys(rpcRegistry);
  assert(names.length >= 60, `only ${names.length} RPCs registered`);
  const broken = [];
  for (const name of names) {
    const res = await call(`/rest/v1/rpc/${name}`, { method: 'POST', token: created.userToken, body: {} });
    if (res.status >= 500) broken.push(`${name} → ${res.status} ${JSON.stringify(res.body)}`);
    if (res.status === 404 && res.body?.code === 'PGRST202') broken.push(`${name} → not routed`);
  }
  assert(!broken.length, `${broken.length} broken: ${broken.slice(0, 5).join(' | ')}`);
});

await test('anonymous callers cannot run an owner-scoped RPC', async () => {
  const res = await call('/rest/v1/rpc/user_store_ids', { method: 'POST', token: null, body: {} });
  assert(res.status >= 400 || JSON.stringify(res.body) === '[]', `status ${res.status} ${JSON.stringify(res.body)}`);
});

// ═════════════════════════════════════════════════════════════════════
GROUP('storage');

let objectPath = null;

const upload = (bucket, key, token, text = 'hello storage') => {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), 'file.txt');
  return fetch(`${base}/storage/v1/object/${bucket}/${key}`, {
    method: 'POST',
    headers: token ? { apikey: ANON, authorization: `Bearer ${token}` } : { apikey: ANON },
    body: form,
  });
};

await test('upload stores the file under the caller folder and returns its path', async () => {
  const res = await upload('uploads', `${created.userId}/tests/${Date.now()}.txt`, created.userToken);
  const body = await res.json().catch(() => null);
  assert(res.ok, `status ${res.status} ${JSON.stringify(body)}`);
  objectPath = String(body.Key || body.key).replace(/^uploads\//, '');
  assert(objectPath.startsWith(`${created.userId}/`), `path ${objectPath} is not under the user folder`);
  assert(typeof body.publicUrl === 'string' && body.publicUrl.includes(objectPath), 'publicUrl missing');
});

await test('public download returns the bytes', async () => {
  const res = await fetch(`${base}/storage/v1/object/public/uploads/${objectPath}`);
  const text = await res.text();
  assert(res.ok, `status ${res.status}`);
  eq(text, 'hello storage');
});

await test('a brand-new bucket and folder are created by the first upload', async () => {
  const bucket = `scratch-${Date.now()}`;
  const res = await upload(bucket, `${created.userId}/deep/nested/file.txt`, created.userToken, 'auto-created');
  const body = await res.json().catch(() => null);
  assert(res.ok, `status ${res.status} ${JSON.stringify(body)}`);
  const dl = await fetch(`${base}/storage/v1/object/public/${bucket}/${created.userId}/deep/nested/file.txt`);
  eq(await dl.text(), 'auto-created');
  await pool.query('DELETE FROM storage.objects WHERE bucket_id = $1', [bucket]);
  await pool.query('DELETE FROM storage.buckets WHERE id = $1', [bucket]);
});

await test('a user cannot write into another user folder', async () => {
  const res = await upload('uploads', `00000000-0000-0000-0000-000000000000/x.txt`, created.userToken);
  eq(res.status, 403);
});

await test('admin-only buckets reject a normal user', async () => {
  const res = await upload('platform-assets', `tests/${Date.now()}.txt`, created.userToken);
  eq(res.status, 403);
});

await test('anonymous upload is rejected', async () => {
  const res = await upload('uploads', `anon-${Date.now()}.txt`, null);
  eq(res.status, 401);
});

await test('missing object download returns 404', async () => {
  const res = await fetch(`${base}/storage/v1/object/public/uploads/missing-${Date.now()}.txt`);
  eq(res.status, 404);
});

// ═════════════════════════════════════════════════════════════════════
GROUP('functions');

await test('unknown function returns 404', async () => {
  const res = await call('/functions/v1/nope', { method: 'POST', token: created.userToken, body: {} });
  eq(res.status, 404);
});

await test('protected functions reject anonymous callers, public ones do not 401', async () => {
  const wrong = [];
  for (const [name, def] of Object.entries(edgeFunctions)) {
    const res = await call(`/functions/v1/${name}`, { method: 'POST', token: null, body: {} });
    if (def.verifyJwt && res.status !== 401) wrong.push(`${name} should be protected (got ${res.status})`);
    if (!def.verifyJwt && res.status === 401) wrong.push(`${name} should be public (got 401)`);
  }
  assert(!wrong.length, wrong.join(' | '));
});

await test('exactly four functions are public', async () => {
  const open = Object.entries(edgeFunctions).filter(([, d]) => !d.verifyJwt).map(([n]) => n);
  eq(open.length, 4, `public functions ${JSON.stringify(open)}:`);
});

await test('a protected function is reachable with a session', async () => {
  const res = await call('/functions/v1/phone-otp', { method: 'POST', token: created.userToken, body: { action: 'send' } });
  assert(res.status < 500, `status ${res.status} ${JSON.stringify(res.body)}`);
});

await test('CORS preflight is allowed', async () => {
  const res = await fetch(`${base}/functions/v1/create-payment`, {
    method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
  });
  assert(res.status < 400 && res.headers.get('access-control-allow-origin'), `status ${res.status}`);
});

await test('no function returns a 5xx on an empty payload', async () => {
  const crashed = [];
  for (const name of Object.keys(edgeFunctions)) {
    const res = await call(`/functions/v1/${name}`, { method: 'POST', token: created.userToken, body: {} });
    if (res.status >= 500) crashed.push(`${name} → ${res.status}`);
  }
  assert(!crashed.length, crashed.join(' | '));
});

// ═════════════════════════════════════════════════════════════════════
GROUP('realtime');

await test('an order insert is pushed to a subscribed socket', async () => {
  const url = `${base.replace('http', 'ws')}/realtime/v1/websocket?apikey=${created.userToken}`;
  const ws = new WebSocket(url);
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no realtime message within 8s')), 8000);
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('open', async () => {
      ws.send(JSON.stringify({
        topic: `realtime:orders-new-${created.storeId}`,
        event: 'phx_join',
        ref: '1',
        payload: {
          config: {
            postgres_changes: [{ id: 1, event: 'INSERT', schema: 'public', table: 'orders', filter: `store_id=eq.${created.storeId}` }],
          },
        },
      }));
      setTimeout(() => {
        pool.query(
          `INSERT INTO public.orders (id, store_id, status, order_number)
             VALUES (gen_random_uuid(), $1, 'pending', 'RT-' || floor(random() * 1e9)::text)`,
          [created.storeId],
        ).catch(reject);
      }, 400);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'postgres_changes') { clearTimeout(timer); resolve(msg); }
    });
  }).finally(() => ws.close());
  eq(message.payload.data.table, 'orders');
  eq(message.payload.data.type, 'INSERT');
});

// ═════════════════════════════════════════════════════════════════════
GROUP('cleanup');

await test('rows and scratch objects are removed', async () => {
  await pool.query('DELETE FROM public.orders WHERE store_id = $1', [created.storeId]);
  await pool.query('DELETE FROM public.products WHERE store_id = $1', [created.storeId]);
  await pool.query('DELETE FROM public.platform_stores WHERE id = $1', [created.storeId]);
  await pool.query('DELETE FROM auth.users WHERE email = $1', [email]);
  for (const t of scratchTables) await pool.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
  await pool.query(`ALTER TABLE public.products
      DROP COLUMN IF EXISTS test_autocol, DROP COLUMN IF EXISTS patch_autocol,
      DROP COLUMN IF EXISTS auto_flag, DROP COLUMN IF EXISTS auto_count,
      DROP COLUMN IF EXISTS auto_amount, DROP COLUMN IF EXISTS auto_meta,
      DROP COLUMN IF EXISTS auto_when`);
  await pool.query(`DELETE FROM public._schema_migrations WHERE kind = 'auto'`);
  const drift = await schemaDrift();
  eq(drift.missingTables.length, 0, 'tables missing after cleanup:');
  eq(drift.missingColumns.length, 0, 'columns missing after cleanup:');
});

// ═════════════════════════════════════════════════════════════════════
const failed = results.filter((r) => !r.ok);
const byGroup = [...new Set(results.map((r) => r.group))];
console.log('\n══ summary ══════════════════════════════════════════════');
for (const g of byGroup) {
  const rows = results.filter((r) => r.group === g);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${g.padEnd(12)} ${rows.length - bad}/${rows.length} passed`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(` - [${f.group}] ${f.name}: ${f.error}`);

server.close();
await pool.end().catch(() => {});
process.exit(failed.length ? 1 : 0);
