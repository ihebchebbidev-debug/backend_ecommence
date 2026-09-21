// End-to-end smoke test: boots the server in-process and exercises every layer
// (health, auth, REST, RPC, storage, edge functions, realtime) against a real
// PostgreSQL database.
//   DATABASE_URL=... node scripts/smoke-test.js
import { server } from '../src/server.js';
import { pool } from '../src/db.js';
import { signApiKey } from '../src/lib/jwt.js';

const ANON = process.env.ANON_KEY || signApiKey('anon');
const SERVICE = process.env.SERVICE_ROLE_KEY || signApiKey('service_role');

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
}

const base = await new Promise((resolve) => {
  server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
});

async function call(path, { method = 'GET', token = ANON, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      apikey: ANON,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const email = `smoke+${Date.now()}@example.com`;
const password = 'secret123';

try {
  // ── health ─────────────────────────────────────────────────────────
  const health = await call('/health');
  check('GET /health', health.status === 200 && health.body?.db === 'up', JSON.stringify(health.body));

  // ── auth ───────────────────────────────────────────────────────────
  const signup = await call('/auth/v1/signup', { method: 'POST', body: { email, password, data: { full_name: 'Smoke Test' } } });
  check('POST /auth/v1/signup', signup.status === 200 && !!signup.body?.session?.access_token, JSON.stringify(signup.body));
  const userToken = signup.body?.session?.access_token;
  const refresh = signup.body?.session?.refresh_token;
  const userId = signup.body?.id;

  const dup = await call('/auth/v1/signup', { method: 'POST', body: { email, password } });
  check('signup rejects duplicate email', dup.status === 422, `status ${dup.status}`);

  const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  check('POST /auth/v1/token (password)', login.status === 200 && !!login.body?.access_token, JSON.stringify(login.body));

  const badLogin = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'wrong' } });
  check('wrong password → 400 invalid_credentials', badLogin.status === 400, `status ${badLogin.status}`);

  const refreshed = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } });
  check('POST /auth/v1/token (refresh_token)', refreshed.status === 200 && !!refreshed.body?.access_token, JSON.stringify(refreshed.body));

  const me = await call('/auth/v1/user', { token: userToken });
  check('GET /auth/v1/user', me.status === 200 && me.body?.email === email, JSON.stringify(me.body));

  const badJwt = await call('/rest/v1/profiles', { token: 'not-a-jwt' });
  check('invalid bearer → 401', badJwt.status === 401, `status ${badJwt.status}`);

  // ── REST ───────────────────────────────────────────────────────────
  const profile = await call(`/rest/v1/profiles?id=eq.${userId}&select=id,email,full_name`, { token: userToken });
  check('GET /rest/v1/profiles (own row)', profile.status === 200 && profile.body?.[0]?.email === email, JSON.stringify(profile.body));

  const store = await call('/rest/v1/platform_stores', {
    method: 'POST',
    token: userToken,
    body: { slug: `smoke-${Date.now()}`, store_name: 'Smoke Store', user_id: userId },
    headers: { prefer: 'return=representation' },
  });
  check('POST /rest/v1/platform_stores', store.status === 201 && !!store.body?.[0]?.id, JSON.stringify(store.body));
  const storeId = store.body?.[0]?.id;

  const patched = await call(`/rest/v1/platform_stores?id=eq.${storeId}`, {
    method: 'PATCH', token: userToken, body: { store_name: 'Renamed' }, headers: { prefer: 'return=representation' },
  });
  check('PATCH /rest/v1/platform_stores', patched.status === 200 && patched.body?.[0]?.store_name === 'Renamed', JSON.stringify(patched.body));

  const product = await call('/rest/v1/products', {
    method: 'POST', token: userToken,
    body: { store_id: storeId, name: 'Smoke Product', price: 42 },
    headers: { prefer: 'return=representation' },
  });
  check('POST /rest/v1/products', product.status === 201 && !!product.body?.[0]?.id, JSON.stringify(product.body));

  const publicRead = await call(`/rest/v1/products?store_id=eq.${storeId}&select=id,name,price`, { token: null });
  check('anon storefront read of products', publicRead.status === 200 && publicRead.body?.length === 1, JSON.stringify(publicRead.body));

  const denied = await call('/rest/v1/profiles?select=*', { token: null });
  check('anon cannot list profiles', denied.status === 401 || denied.status === 403 || (Array.isArray(denied.body) && denied.body.length === 0), `status ${denied.status} ${JSON.stringify(denied.body)}`);

  const secretTable = await call('/rest/v1/phone_otp_codes?select=*', { token: userToken });
  check('denied table blocked over REST', secretTable.status >= 400, `status ${secretTable.status}`);

  const count = await call('/rest/v1/products?select=id', { token: userToken, headers: { prefer: 'count=exact' } });
  check('count=exact returns content-range', !!count.headers.get('content-range'), String(count.headers.get('content-range')));

  // ── RPC ────────────────────────────────────────────────────────────
  const rpcMissing = await call('/rest/v1/rpc/definitely_not_a_function', { method: 'POST', token: userToken, body: {} });
  check('unknown RPC → PGRST202', rpcMissing.status === 404 && rpcMissing.body?.code === 'PGRST202', JSON.stringify(rpcMissing.body));

  const isActive = await call('/rest/v1/rpc/is_active_user', { method: 'POST', token: userToken, body: {} });
  check('RPC is_active_user', isActive.status === 200 && isActive.body === true, JSON.stringify(isActive.body));

  const storeIds = await call('/rest/v1/rpc/user_store_ids', { method: 'POST', token: userToken, body: {} });
  check('RPC user_store_ids includes new store', storeIds.status === 200 && JSON.stringify(storeIds.body).includes(storeId), JSON.stringify(storeIds.body));

  const superAdmin = await call('/rest/v1/rpc/is_super_admin', { method: 'POST', token: userToken, body: {} });
  check('RPC is_super_admin false for new user', superAdmin.status === 200 && superAdmin.body === false, JSON.stringify(superAdmin.body));

  // ── storage ────────────────────────────────────────────────────────
  const form = new FormData();
  form.append('file', new Blob(['hello storage'], { type: 'text/plain' }), 'smoke.txt');
  const upload = await fetch(`${base}/storage/v1/object/platform-assets/smoke/${Date.now()}.txt`, {
    method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${userToken}` }, body: form,
  });
  const uploadBody = await upload.json().catch(() => null);
  check('POST /storage/v1/object upload', upload.ok, `status ${upload.status} ${JSON.stringify(uploadBody)}`);
  const objectKey = uploadBody?.Key || uploadBody?.key;
  if (objectKey) {
    const path = String(objectKey).replace(/^platform-assets\//, '');
    const download = await fetch(`${base}/storage/v1/object/public/platform-assets/${path}`);
    const content = await download.text();
    check('GET /storage/v1/object/public download', download.ok && content === 'hello storage', `status ${download.status} body ${content.slice(0, 40)}`);
  }

  // ── edge functions ─────────────────────────────────────────────────
  const fnMissing = await call('/functions/v1/nope', { method: 'POST', token: userToken, body: {} });
  check('unknown function → 404', fnMissing.status === 404, `status ${fnMissing.status}`);

  const protectedFn = await call('/functions/v1/reset-otp-rate-limit', { method: 'POST', token: null, body: {} });
  check('verify_jwt function rejects anon', protectedFn.status === 401, `status ${protectedFn.status}`);

  // phone-otp requires a JWT at the gateway and re-checks the caller in code.
  const otpAnon = await call('/functions/v1/phone-otp', { method: 'POST', token: null, body: {} });
  check('phone-otp rejects anon', otpAnon.status === 401, `status ${otpAnon.status}`);
  const otpUser = await call('/functions/v1/phone-otp', { method: 'POST', token: userToken, body: { action: 'send' } });
  check('phone-otp reachable with a session', otpUser.status === 400, `status ${otpUser.status} ${JSON.stringify(otpUser.body)}`);

  const cors = await fetch(`${base}/functions/v1/create-payment`, {
    method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
  });
  check('CORS preflight allowed', cors.status < 400 && !!cors.headers.get('access-control-allow-origin'), `status ${cors.status}`);

  // ── service role ───────────────────────────────────────────────────
  const svc = await call('/rest/v1/profiles?select=id&limit=1', { token: SERVICE });
  check('service_role reads any table', svc.status === 200, JSON.stringify(svc.body));

  // ── cleanup ────────────────────────────────────────────────────────
  await call(`/rest/v1/products?store_id=eq.${storeId}`, { method: 'DELETE', token: userToken });
  await call(`/rest/v1/platform_stores?id=eq.${storeId}`, { method: 'DELETE', token: userToken });
  await pool.query('DELETE FROM auth.users WHERE email = $1', [email]);
} catch (err) {
  failures.push(`threw: ${err.stack}`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(` - ${f}`)); }
server.close();
await pool.end().catch(() => {});
process.exit(failures.length ? 1 : 0);
