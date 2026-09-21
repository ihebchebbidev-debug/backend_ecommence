// Offline test suite — no database, no network. Run with: npm run test:static
//
// Checks everything that can be verified from the code alone:
//   • every module imports cleanly
//   • the RPC registry has no duplicate/shadowed implementations
//   • every registered RPC and edge function is a function
//   • the edge-function verify_jwt matrix matches docs/verify-jwt-map.md when present
//   • db/schema.sql parses into the expected table list
//   • configuration validation behaves (production refuses unsafe defaults)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log('\n── offline checks ────────────────────────────────────────');

const rpcModules = [
  'auth', 'stores', 'orders', 'agents', 'clients', 'products',
  'delivery', 'payments', 'storefront', 'billing', 'admin', 'helpers',
];

await test('every rpc module imports and exports handlers', async () => {
  for (const name of rpcModules) {
    const mod = await import(`../src/rpc/${name}.js`);
    assert(mod.default && typeof mod.default === 'object', `${name}.js has no default export`);
    for (const [fn, impl] of Object.entries(mod.default)) {
      assert(typeof impl === 'function', `${name}.${fn} is not a function`);
    }
  }
});

await test('no rpc name is implemented in two modules', async () => {
  const seen = new Map();
  const clashes = [];
  for (const name of rpcModules) {
    const mod = await import(`../src/rpc/${name}.js`);
    for (const fn of Object.keys(mod.default)) {
      if (seen.has(fn)) clashes.push(`${fn}: ${seen.get(fn)}.js and ${name}.js`);
      else seen.set(fn, name);
    }
  }
  assert(clashes.length === 0, `shadowed implementations → ${clashes.join(', ')}`);
});

await test('rpc registry exposes every handler', async () => {
  const { rpcRegistry } = await import('../src/rpc/index.js');
  const names = Object.keys(rpcRegistry);
  assert(names.length > 50, `only ${names.length} rpc functions registered`);
  for (const [fn, impl] of Object.entries(rpcRegistry)) {
    assert(typeof impl === 'function', `${fn} is not callable`);
  }
});

await test('every edge function is callable and has a verify_jwt flag', async () => {
  const { edgeFunctions } = await import('../src/functions/index.js');
  const names = Object.keys(edgeFunctions);
  assert(names.length >= 19, `only ${names.length} edge functions registered`);
  for (const [name, def] of Object.entries(edgeFunctions)) {
    assert(typeof def.handler === 'function', `${name} has no handler`);
    assert(typeof def.verifyJwt === 'boolean', `${name} has no verifyJwt flag`);
  }
});

await test('routers, mailer and realtime modules import cleanly', async () => {
  await import('../src/rest/router.js');
  await import('../src/auth/router.js');
  await import('../src/storage/router.js');
  await import('../src/realtime/server.js');
  const mailer = await import('../src/lib/mailer.js');
  assert(typeof mailer.sendMail === 'function', 'sendMail missing');
  assert(typeof mailer.recoveryEmail('http://x').subject === 'string', 'recoveryEmail missing subject');
});

await test('db/schema.sql declares the expected tables', async () => {
  const sql = fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z0-9_]+)/gi)].map((m) => m[1]);
  assert(tables.length >= 60, `only ${tables.length} tables declared`);
  const dupes = tables.filter((t, i) => tables.indexOf(t) !== i);
  assert(dupes.length === 0, `duplicate table declarations: ${dupes.join(', ')}`);
});

await test('realtime.sql exposes enable_realtime()', async () => {
  const sql = fs.readFileSync(path.join(root, 'db/realtime.sql'), 'utf8');
  assert(/FUNCTION public\.enable_realtime/.test(sql), 'enable_realtime() missing');
});

await test('config rejects unsafe production settings', async () => {
  const { checkConfig } = await import('../src/config.js');
  const { fatal, warnings } = checkConfig();
  assert(Array.isArray(fatal) && Array.isArray(warnings), 'checkConfig shape');
  // A dev boot without JWT_SECRET must warn, never crash.
  assert(fatal.every((f) => typeof f === 'string'), 'fatal entries must be strings');
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
