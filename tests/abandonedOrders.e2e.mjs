// End-to-end regression tests for incomplete checkouts (abandoned orders) and
// order stock bookkeeping, against the real server and a disposable database.
//
//   DATABASE_URL=postgres://... node --test tests/abandonedOrders.e2e.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { purchaseAllowed } from '../src/functions/storefront-meta-event.js';

test('an incomplete checkout is never reported to Meta as a purchase', () => {
  const now = Date.now();
  assert.equal(purchaseAllowed({ status: 'abandoned', created_at: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(purchaseAllowed({ status: 'pending', created_at: new Date(now - 1000).toISOString() }, now), true);
});

if (!process.env.DATABASE_URL) {
  test('abandoned orders e2e (skipped: set DATABASE_URL to a disposable database)', { skip: true }, () => {});
} else {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'e2e-service-role-secret';
  const { server, bootstrap } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const { signApiKey } = await import('../src/lib/jwt.js');
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
  const rpc = (name, args, auth = true) => call(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, auth });
  const one = (b) => (Array.isArray(b) ? b[0] : b);
  let phoneSeq = 30000000;
  const newPhone = () => String(++phoneSeq);

  async function product(stock = 10, price = 20) {
    const [p] = await sql(`INSERT INTO public.products (store_id, name, price, delivery_fee, stock, status)
      VALUES ($1, $2, $3, 7, $4, 'active') RETURNING id`, [storeId, `P-${crypto.randomUUID().slice(0, 6)}`, price, stock]);
    return p.id;
  }
  const stockOf = async (id) => Number((await sql('SELECT stock FROM public.products WHERE id=$1', [id]))[0].stock);
  const capture = (requestId, phone, items) => rpc('capture_abandoned_checkout', { p_store_id: storeId, p_checkout_request_id: requestId, p_phone: phone, p_name: 'Shopper', p_items: items }, false);
  const place = (requestId, phone, items) => rpc('create_public_order', {
    p_store_id: storeId, p_checkout_request_id: requestId, p_currency: 'TND', p_payment_method: 'cod',
    p_client: { name: 'Shopper', phone, address: 'Rue de Test 12', city: 'Tunis', region: 'Tunis' }, p_items: items,
  }, false);
  const setStatus = (orderId, status) => call(`/rest/v1/orders?id=eq.${orderId}`, { method: 'PATCH', body: { status } });

  before(async () => {
    await bootstrap({ force: true });
    base = await new Promise((resolve) => server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`)));
    const email = `abandoned+${Date.now()}@example.com`;
    await call('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password: 'secret123', data: { full_name: 'Abandoned Tester' } } });
    const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password: 'secret123' } });
    token = login.body?.access_token;
    assert.ok(token, 'sign in failed');
    const st = await rpc('create_initial_store_for_user', { p_input: { store_name: `Abandoned ${Date.now()}`, selected_plan: 'starter' } });
    storeId = one(st.body)?.created_store_id;
    assert.ok(storeId, `shop creation failed: ${JSON.stringify(st.body)}`);
    await sql("UPDATE public.platform_stores SET currency='TND', status='active' WHERE id=$1", [storeId]);
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  test('a capture keeps the whole basket and reserves no stock', async () => {
    const a = await product(10), b = await product(5);
    const req = crypto.randomUUID();
    const r = await capture(req, newPhone(), [{ product_id: a, quantity: 2 }, { product_id: b, quantity: 1 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [order] = await sql('SELECT id, status, merchandise_subtotal FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2', [storeId, req]);
    assert.equal(order.status, 'abandoned');
    assert.equal(order.merchandise_subtotal, null);
    const items = await sql('SELECT product_id, quantity FROM public.order_items WHERE order_id=$1 ORDER BY created_at', [order.id]);
    assert.equal(items.length, 2);
    assert.equal(await stockOf(a), 10);
    assert.equal(await stockOf(b), 5);
  });

  test('completing a capture works under a one-order-per-phone limit and keeps its number', async () => {
    await sql(`INSERT INTO public.store_settings (store_id, key, value) VALUES ($1,'max_orders_per_phone','1'),($1,'min_order_delay_hours','2')
      ON CONFLICT DO NOTHING`, [storeId]);
    try {
      const a = await product(10);
      const req = crypto.randomUUID(), phone = newPhone(), items = [{ product_id: a, quantity: 2 }];
      assert.equal((await capture(req, phone, items)).status, 200);
      const [captured] = await sql("SELECT id, order_number FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2", [storeId, req]);
      await sql("UPDATE public.orders SET created_at = now() - interval '3 days' WHERE id=$1", [captured.id]);
      const [seqBefore] = await sql('SELECT next_val FROM public.store_order_seq WHERE store_id=$1', [storeId]);
      const placed = await place(req, phone, items);
      assert.equal(placed.status, 200, JSON.stringify(placed.body));
      assert.equal(one(placed.body).order_id, captured.id);
      assert.equal(one(placed.body).order_number, captured.order_number);
      const [row] = await sql('SELECT status, created_at FROM public.orders WHERE id=$1', [captured.id]);
      assert.equal(row.status, 'pending');
      assert.ok(Date.now() - new Date(row.created_at).getTime() < 60_000, 'order date is the completion time');
      const [seqAfter] = await sql('SELECT next_val FROM public.store_order_seq WHERE store_id=$1', [storeId]);
      assert.equal(Number(seqAfter.next_val), Number(seqBefore.next_val), 'no order number is burned');
      assert.equal(await stockOf(a), 8);
      // The limit still applies to a genuinely second order from the same phone.
      const second = await place(crypto.randomUUID(), phone, items);
      assert.equal(second.status, 403);
    } finally {
      await sql("DELETE FROM public.store_settings WHERE store_id=$1 AND key IN ('max_orders_per_phone','min_order_delay_hours')", [storeId]);
    }
  });

  test('a capture the seller moved to the trash comes back when the shopper completes it', async () => {
    const a = await product(10);
    const req = crypto.randomUUID(), phone = newPhone(), items = [{ product_id: a, quantity: 1 }];
    await capture(req, phone, items);
    const [captured] = await sql('SELECT id FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2', [storeId, req]);
    assert.equal((await rpc('soft_delete_store_order', { p_order_id: captured.id })).status, 200);
    assert.equal((await place(req, phone, items)).status, 200);
    const [row] = await sql('SELECT status, deleted_at FROM public.orders WHERE id=$1', [captured.id]);
    assert.equal(row.status, 'pending');
    assert.equal(row.deleted_at, null);
    const items2 = await sql('SELECT quantity FROM public.order_items WHERE order_id=$1', [captured.id]);
    assert.equal(items2.length, 1, 'capture lines are replaced, not duplicated');
  });

  test('cancel, reopen, return and cancel again keep stock exact', async () => {
    const a = await product(10);
    const placed = await place(crypto.randomUUID(), newPhone(), [{ product_id: a, quantity: 3 }]);
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    const orderId = one(placed.body).order_id;
    assert.equal(await stockOf(a), 7);
    assert.ok((await setStatus(orderId, 'cancelled')).status < 300);
    assert.equal(await stockOf(a), 10);
    assert.ok((await setStatus(orderId, 'pending')).status < 300);
    assert.equal(await stockOf(a), 7, 'reopened order takes its stock again');
    assert.ok((await setStatus(orderId, 'returned')).status < 300);
    assert.equal(await stockOf(a), 10, 'returned parcel goes back to stock');
    assert.ok((await setStatus(orderId, 'cancelled')).status < 300);
    assert.equal(await stockOf(a), 10, 'never returned twice');
  });

  test('editing quantities on a placed order moves stock by the difference only', async () => {
    const a = await product(20);
    const placed = await place(crypto.randomUUID(), newPhone(), [{ product_id: a, quantity: 2 }]);
    const orderId = one(placed.body).order_id;
    assert.equal(await stockOf(a), 18);
    const edit = await rpc('set_order_lines_manual', { p_order_id: orderId, p_lines: [{ product_id: a, product_name: 'Main', quantity: 5, unit_price: 20, line_total: 100 }] });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(await stockOf(a), 15);
    assert.ok((await setStatus(orderId, 'cancelled')).status < 300);
    assert.equal(await stockOf(a), 20, 'cancelling gives back exactly what is reserved');
  });

  test('the phone app cannot edit, prepare or change the status of an incomplete checkout', async () => {
    const a = await product(10);
    const req = crypto.randomUUID();
    await capture(req, newPhone(), [{ product_id: a, quantity: 1 }]);
    const [captured] = await sql('SELECT id FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2', [storeId, req]);
    const key = () => crypto.randomUUID().replace(/-/g, '');
    const status = await rpc('mobile_order_set_status', { p_store_id: storeId, p_order_id: captured.id, p_status: 'confirmed', p_idempotency_key: key() });
    assert.equal(status.status, 409, JSON.stringify(status.body));
    const edit = await rpc('mobile_order_update', { p_store_id: storeId, p_order_id: captured.id, p_patch: { notes: 'x' }, p_idempotency_key: key() });
    assert.equal(edit.status, 409, JSON.stringify(edit.body));
    const prep = await rpc('mobile_prepare_order', { p_store_id: storeId, p_order_id: captured.id, p_idempotency_key: key() });
    assert.equal(one(prep.body).outcome, 'not_preparable');
    const [row] = await sql('SELECT status, prepared_at FROM public.orders WHERE id=$1', [captured.id]);
    assert.equal(row.status, 'abandoned');
    assert.equal(row.prepared_at, null);
  });

  test('seller order list sorts by the chosen column', async () => {
    const r = await rpc('get_store_orders_secure_paginated', { p_store_id: storeId, p_limit: 50, p_offset: 0, p_sort_col: 'amount', p_sort_dir: 'asc' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const amounts = r.body.map((o) => Number(o.amount));
    assert.ok(amounts.length > 1);
    assert.deepEqual(amounts, [...amounts].sort((x, y) => x - y));
  });

  test('trashing an unshipped order gives its stock back once; restoring takes it again', async () => {
    const a = await product(10);
    const placed = await place(crypto.randomUUID(), newPhone(), [{ product_id: a, quantity: 2 }]);
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    const orderId = one(placed.body).order_id;
    assert.equal(await stockOf(a), 8);
    assert.equal((await rpc('soft_delete_store_order', { p_order_id: orderId })).status, 200);
    assert.equal(await stockOf(a), 10, 'trashed pending order releases its 2 units');
    assert.equal((await rpc('soft_delete_store_order', { p_order_id: orderId })).status, 200);
    assert.equal(await stockOf(a), 10, 'never released twice');
    assert.equal((await rpc('restore_store_order', { p_order_id: orderId })).status, 200);
    assert.equal(await stockOf(a), 8, 'restored order reserves its 2 units again');
  });

  test('trashing a delivered order leaves stock unchanged', async () => {
    const a = await product(10);
    const placed = await place(crypto.randomUUID(), newPhone(), [{ product_id: a, quantity: 3 }]);
    const orderId = one(placed.body).order_id;
    assert.ok((await setStatus(orderId, 'delivered')).status < 300);
    assert.equal(await stockOf(a), 7);
    assert.equal((await rpc('soft_delete_store_order', { p_order_id: orderId })).status, 200);
    assert.equal(await stockOf(a), 7, 'delivered goods are gone; trash must not add them back');
  });

  test('two bundles in one line are charged and reserved twice', async () => {
    const a = await product(20, 20);
    const [b] = await sql(`INSERT INTO public.product_bundles (product_id, name, label, price, quantity) VALUES ($1,'Pack 3','3 pieces',50,3) RETURNING id`, [a]);
    const placed = await place(crypto.randomUUID(), newPhone(), [{ product_id: a, bundle_id: b.id, bundle_count: 2, quantity: 6 }]);
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    assert.equal(await stockOf(a), 14, '2 bundles of 3 pieces');
    const [row] = await sql('SELECT merchandise_subtotal FROM public.orders WHERE id=$1', [one(placed.body).order_id]);
    assert.equal(Number(row.merchandise_subtotal), 100, '2 x 50');
  });

  test('the transit tab also lists orders handed to a carrier', async () => {
    const a = await product(10);
    const placed = await place(crypto.randomUUID(), newPhone(), [{ product_id: a, quantity: 1 }]);
    const orderId = one(placed.body).order_id;
    assert.ok((await setStatus(orderId, 'shipped')).status < 300);
    const r = await rpc('get_store_orders_secure_paginated', { p_store_id: storeId, p_status: 'transit', p_limit: 200, p_offset: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.some((o) => o.id === orderId));
  });
}
