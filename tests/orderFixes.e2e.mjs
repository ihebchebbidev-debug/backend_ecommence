// End-to-end regression tests for order editing, deletion, restoration,
// duplicate payment links and manual-order currency.
//
//   DATABASE_URL=postgres://... node --test tests/orderFixes.e2e.mjs
//
// Boots the real server in-process against a disposable PostgreSQL database and
// drives it over HTTP exactly like the seller website does. Only the Konnect
// payment provider is stubbed (no real money moves).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

if (!process.env.DATABASE_URL) {
  test('order fixes e2e (skipped: set DATABASE_URL to a disposable database)', { skip: true }, () => {});
} else {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'e2e-service-role-secret';
  const { server, bootstrap } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const { signApiKey } = await import('../src/lib/jwt.js');
  const { encryptPaymentJson } = await import('../src/functions/_shared/paymentCrypto.js');
  const ANON = signApiKey('anon');

  let base, token, storeId;
  const sql = (q, p) => pool.query(q, p).then((r) => r.rows);
  async function call(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { apikey: ANON, authorization: `Bearer ${auth ? token : ANON}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  const rpc = (name, args) => call(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });
  const one = (b) => (Array.isArray(b) ? b[0] : b);

  /** Manual order exactly as the Orders screen inserts it (no currency sent). */
  async function manualOrder(amount = 100) {
    const r = await call('/rest/v1/orders', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: { store_id: storeId, order_number: `M-${crypto.randomUUID().slice(0, 8)}`, client_name: 'Test Client', client_phone: '+21622000111', status: 'pending', amount },
    });
    assert.ok(r.status < 300, `manual order insert failed: ${r.status} ${JSON.stringify(r.body)}`);
    return one(r.body);
  }

  before(async () => {
    await bootstrap({ force: true });
    base = await new Promise((resolve) => server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`)));
    const email = `orders+${Date.now()}@example.com`;
    await call('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password: 'secret123', data: { full_name: 'Order Tester' } } });
    const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password: 'secret123' } });
    token = login.body?.access_token;
    assert.ok(token, 'sign in failed');
    const st = await rpc('create_initial_store_for_user', { p_input: { store_name: `Orders ${Date.now()}`, selected_plan: 'starter' } });
    storeId = one(st.body)?.created_store_id;
    assert.ok(storeId, `shop creation failed: ${JSON.stringify(st.body)}`);
    await sql("UPDATE public.platform_stores SET currency='USD' WHERE id=$1", [storeId]);
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  test('manual order in a USD shop is saved in USD, not TND', async () => {
    const order = await manualOrder(100);
    const [row] = await sql('SELECT currency, amount FROM public.orders WHERE id=$1', [order.id]);
    assert.equal(row.currency, 'USD');
    assert.equal(Number(row.amount), 100);
  });

  test('saving changed product lines on an order succeeds and replaces the lines', async () => {
    const order = await manualOrder(150);
    const r = await rpc('set_order_lines_manual', { p_order_id: order.id, p_lines: [
      { product_name: 'Robe', quantity: 2, unit_price: 50, line_total: 100 },
      { product_name: 'Sac', quantity: 1, unit_price: 50, line_total: 50 },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(one(r.body).count, 2);
    const r2 = await rpc('set_order_lines_manual', { p_order_id: order.id, p_lines: [{ product_name: 'Robe', quantity: 3, unit_price: 50, line_total: 150 }] });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const items = await rpc('get_order_items', { p_order_id: order.id });
    assert.equal(items.body.length, 1);
    assert.equal(items.body[0].quantity, 3);
  });

  test('deleting then restoring an order works', async () => {
    const order = await manualOrder(80);
    const del = await rpc('soft_delete_store_order', { p_order_id: order.id });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(one(del.body), true);
    assert.notEqual((await sql('SELECT deleted_at FROM public.orders WHERE id=$1', [order.id]))[0].deleted_at, null);
    const res = await rpc('restore_store_order', { p_order_id: order.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(one(res.body), true);
    assert.equal((await sql('SELECT deleted_at FROM public.orders WHERE id=$1', [order.id]))[0].deleted_at, null);
  });

  test('a customer paying through the first of two payment links marks the order paid', async () => {
    const order = await manualOrder(100);
    const { ciphertext, iv, version } = (() => { const e = encryptPaymentJson({ api_key: 'k', wallet_id: 'w', mode: 'test' }); return { ciphertext: e.ciphertext ?? e.encrypted ?? e.credentials_encrypted, iv: e.iv ?? e.credentials_iv, version: e.version ?? e.credentials_version ?? null }; })();
    await sql(`INSERT INTO public.store_payment_integrations (store_id, provider, credentials_encrypted, credentials_iv, credentials_version, is_active, connection_status)
               VALUES ($1,'konnect',$2,$3,$4,true,'connected')`, [storeId, ciphertext, iv, version]);
    // Checkout opened twice: each start replaces the order's reference, as create-store-payment does.
    await sql("UPDATE public.orders SET payment_provider='konnect', payment_ref='REF-FIRST' WHERE id=$1", [order.id]);
    await sql("UPDATE public.orders SET payment_ref='REF-SECOND' WHERE id=$1", [order.id]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('konnect.network') && String(url).includes('/payments/REF-FIRST')) {
        return new Response(JSON.stringify({ payment: { id: 'REF-FIRST', status: 'completed', token: 'USD', amount: 10000, orderId: order.id } }), { status: 200 });
      }
      return realFetch(url, init);
    };
    try {
      const cb = await call('/functions/v1/store-payment-callback', { method: 'POST', auth: false, body: { payment_ref: 'REF-FIRST' } });
      assert.equal(cb.status, 200, JSON.stringify(cb.body));
      assert.equal(cb.body.status, 'paid');
    } finally { globalThis.fetch = realFetch; }
    const [row] = await sql('SELECT payment_status FROM public.orders WHERE id=$1', [order.id]);
    assert.equal(row.payment_status, 'paid');
  });

  test('an unknown payment reference still settles nothing', async () => {
    const cb = await call('/functions/v1/store-payment-callback', { method: 'POST', auth: false, body: { payment_ref: 'REF-NEVER-ISSUED' } });
    assert.equal(cb.status, 404);
  });
}
