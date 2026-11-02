// Usage: start the server, then API_URL=http://localhost:8000 node scripts/live-e2e.mjs
// Live end-to-end test against the real server + PostgreSQL.
import crypto from 'node:crypto';
const BASE = process.env.API_URL || 'http://localhost:8000';
const { signApiKey } = await import('../src/lib/jwt.js');
const ANON = signApiKey('anon');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fails.push(name); console.log('  FAIL', name, '—', typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)); } };
async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(BASE + path, { method, headers: { apikey: ANON, authorization: `Bearer ${token || ANON}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const rpc = (name, args, token) => call(`/rest/v1/rpc/${name}`, { method: 'POST', token, body: args });
const good = r => r.status >= 200 && r.status < 300;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const key = () => crypto.randomUUID();
const stamp = Date.now();

async function owner(label) {
  const email = `${label}+${stamp}@example.com`;
  const s = await call('/auth/v1/signup', { method: 'POST', body: { email, password: 'secret123', data: { full_name: label } } });
  ok(`${label}: sign up`, good(s) && s.body?.access_token, s.body);
  const l = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'secret123' } });
  ok(`${label}: sign in`, good(l) && l.body?.access_token, l.body);
  const bad = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'wrong-pass' } });
  ok(`${label}: wrong password rejected`, bad.status >= 400, bad.status);
  const token = l.body.access_token;
  const st = await rpc('create_initial_store_for_user', { p_input: { store_name: `Boutique ${label} ${stamp}`, selected_plan: 'starter' } }, token);
  const storeId = (Array.isArray(st.body) ? st.body[0] : st.body)?.created_store_id;
  ok(`${label}: create shop`, good(st) && storeId, st.body);
  return { token, storeId, email };
}

console.log('\n== Owner A: account + shop');
const A = await owner('ownerA');
const B = await owner('ownerB');

console.log('\n== Categories CRUD');
let r = await call('/rest/v1/categories', { method: 'POST', token: A.token, headers: { prefer: 'return=representation' }, body: { store_id: A.storeId, name: 'Robes', slug: `robes-${stamp}` } });
const catId = r.body?.[0]?.id; ok('create category', good(r) && catId, r.body);
r = await call(`/rest/v1/categories?id=eq.${catId}`, { method: 'PATCH', token: A.token, headers: { prefer: 'return=representation' }, body: { name: 'Robes été' } });
ok('update category', good(r) && r.body?.[0]?.name === 'Robes été', r.body);

console.log('\n== Products CRUD');
r = await call('/rest/v1/products', { method: 'POST', token: A.token, headers: { prefer: 'return=representation' }, body: { store_id: A.storeId, name: 'Robe lin', price: 89, stock: 20, status: 'active', category_id: catId } });
const prodId = r.body?.[0]?.id; ok('create product', good(r) && prodId, r.body);
r = await call(`/rest/v1/products?id=eq.${prodId}&select=id,name,price,stock`, { token: A.token });
ok('read product', r.body?.[0]?.price == 89, r.body);
r = await call(`/rest/v1/products?id=eq.${prodId}`, { method: 'PATCH', token: A.token, headers: { prefer: 'return=representation' }, body: { price: 79, stock: 15 } });
ok('update product (price/stock)', good(r) && r.body?.[0]?.price == 79 && r.body?.[0]?.stock == 15, r.body);
r = await call('/rest/v1/products', { method: 'POST', token: A.token, headers: { prefer: 'return=representation' }, body: { store_id: A.storeId, name: 'À supprimer', price: 5, stock: 1, status: 'active' } });
const tmpProd = r.body?.[0]?.id;
r = await call(`/rest/v1/products?id=eq.${tmpProd}`, { method: 'DELETE', token: A.token });
ok('delete product', good(r), r.body);
r = await call(`/rest/v1/products?id=eq.${tmpProd}&select=id`, { token: A.token });
ok('deleted product no longer readable', Array.isArray(r.body) && r.body.length === 0, r.body);

console.log('\n== Clients CRUD');
r = await call('/rest/v1/clients', { method: 'POST', token: A.token, headers: { prefer: 'return=representation' }, body: { store_id: A.storeId, name: 'Sami Ben Ali', phone: '+21622111222', city: 'Tunis' } });
const clientId = r.body?.[0]?.id; ok('create client', good(r) && clientId, r.body);
r = await call(`/rest/v1/clients?id=eq.${clientId}`, { method: 'PATCH', token: A.token, headers: { prefer: 'return=representation' }, body: { city: 'Sousse' } });
ok('update client', r.body?.[0]?.city === 'Sousse', r.body);

console.log('\n== Coupons');
r = await rpc('save_store_coupon', { p_store_id: A.storeId, p_coupon: { code: `PROMO${stamp % 10000}`, type: 'percentage', value: 10, active: true } }, A.token);
const couponId = (Array.isArray(r.body) ? r.body[0] : r.body)?.id; ok('create coupon', good(r) && couponId, r.body);
r = await rpc('save_store_coupon', { p_store_id: A.storeId, p_coupon: { code: 'BAD', type: 'percentage', value: 150, active: true } }, A.token);
ok('coupon > 100% rejected', r.status >= 400, r.body);
r = await rpc('set_store_coupon_active', { p_store_id: A.storeId, p_coupon_id: couponId, p_active: false }, A.token);
ok('deactivate coupon', good(r), r.body);
r = await rpc('list_store_coupons', { p_store_id: A.storeId }, A.token);
ok('list coupons shows it inactive', JSON.stringify(r.body).includes('"active":false'), r.body);

console.log('\n== Orders (seller)');
r = await rpc('mobile_create_order', { p_store_id: A.storeId, p_idempotency_key: key(), p_items: [{ product_id: prodId, quantity: 2 }], p_customer: { client_name: 'Leila T', client_phone: '+21698765432', city: 'Tunis', address: 'Rue 1' } }, A.token);
const order = Array.isArray(r.body) ? r.body[0] : r.body; const orderId = order?.order_id ?? order?.id;
ok('create order', good(r) && orderId, r.body);
r = await rpc('get_store_orders_secure_paginated', { p_store_id: A.storeId }, A.token);
ok('list orders contains it', JSON.stringify(r.body).includes(orderId), r.body);
r = await rpc('get_order_secure', { p_order_id: orderId }, A.token);
const ord = Array.isArray(r.body) ? r.body[0] : r.body;
ok('order total server-priced (2 × 79)', Number(ord?.amount) === 158, ord);
r = await call(`/rest/v1/products?id=eq.${prodId}&select=stock`, { token: A.token });
ok('stock reserved after order (15 → 13)', r.body?.[0]?.stock == 13, r.body);
r = await rpc('mobile_order_set_status', { p_store_id: A.storeId, p_order_id: orderId, p_status: 'confirmed', p_idempotency_key: key(), p_expected_updated_at: ord?.updated_at }, A.token);
ok('set order status confirmed', good(r), r.body);
r = await rpc('mobile_order_set_status', { p_store_id: A.storeId, p_order_id: orderId, p_status: 'hacked', p_idempotency_key: key() }, A.token);
ok('invalid status rejected', r.status >= 400, r.body);
r = await rpc('mobile_order_history', { p_store_id: A.storeId, p_order_id: orderId }, A.token);
ok('order history recorded', good(r) && JSON.stringify(r.body).length > 10, r.body);
r = await rpc('soft_delete_store_order', { p_order_id: orderId }, A.token);
ok('move order to trash', good(r), r.body);
r = await rpc('get_store_orders_trash_count', { p_store_id: A.storeId }, A.token);
ok('trash count = 1', JSON.stringify(r.body).includes('1'), r.body);
r = await rpc('restore_store_order', { p_order_id: orderId }, A.token);
ok('restore order', good(r), r.body);

console.log('\n== Cross-shop isolation (owner B against shop A)');
r = await call(`/rest/v1/products?store_id=eq.${A.storeId}&select=id,cost`, { token: B.token });
ok('B cannot see A private product data', !JSON.stringify(r.body).includes('"cost"') || (Array.isArray(r.body) && r.body.every(p => p.cost == null)), r.body);
r = await call(`/rest/v1/products?id=eq.${prodId}`, { method: 'PATCH', token: B.token, headers: { prefer: 'return=representation' }, body: { price: 1 } });
const chk = await call(`/rest/v1/products?id=eq.${prodId}&select=price`, { token: A.token });
ok('B cannot change A product price', chk.body?.[0]?.price == 79, { r: r.body, chk: chk.body });
r = await call(`/rest/v1/clients?store_id=eq.${A.storeId}`, { token: B.token });
ok('B cannot read A clients', r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0), r.body);
r = await rpc('get_store_orders_secure_paginated', { p_store_id: A.storeId }, B.token);
ok('B cannot list A orders', r.status >= 400 || !JSON.stringify(r.body).includes(orderId), r.body);
r = await rpc('team_save_member', { p_store_id: A.storeId, p_values: { name: 'x', username: `x${stamp}`, role: 'agent', status: 'active', permissions: {}, password_hash: sha('x') } }, B.token);
ok('B cannot add a team member to shop A', r.status >= 400, r.body);

console.log('\n== Team: create member with limited permissions');
const username = `agent${stamp}`, pw = 'Agent#2026';
r = await rpc('team_save_member', { p_store_id: A.storeId, p_values: { name: 'Agent Test', username, email: `${username}@example.com`, role: 'orders', status: 'active', password_hash: sha(pw), permissions: { commandes: { read: true, create: true, modify: true, delete: false }, produits: { read: true, create: false, modify: false, delete: false } } } }, A.token);
const memberId = (Array.isArray(r.body) ? r.body[0] : r.body)?.id; ok('owner creates member', good(r) && memberId, r.body);
r = await rpc('team_save_member', { p_store_id: A.storeId, p_values: { name: 'Dup', username, role: 'orders', status: 'active', password_hash: sha(pw), permissions: {} } }, A.token);
ok('duplicate username rejected', r.status >= 400, r.body);
r = await rpc('team_save_member', { p_store_id: A.storeId, p_values: { name: 'Evil', username: `evil${stamp}`, role: 'super_admin', status: 'active', password_hash: sha(pw), permissions: {} } }, A.token);
ok('unknown role (super_admin) rejected', r.status >= 400, r.body);
r = await rpc('team_save_member', { p_store_id: A.storeId, p_values: { name: 'Evil', username: `evil2${stamp}`, role: 'agent', status: 'active', password_hash: sha(pw), permissions: { root: { read: true } } } }, A.token);
ok('unknown permission key rejected', r.status >= 400, r.body);
r = await rpc('team_owner_members', { p_store_id: A.storeId }, A.token);
ok('member appears in team list', JSON.stringify(r.body).includes(memberId), r.body);
ok('team list never returns password hash', !JSON.stringify(r.body).includes(sha(pw)), 'hash leaked');

console.log('\n== Member login + permissions');
r = await rpc('agent_login', { p_username: username, p_password_hash: sha('wrong') });
ok('member wrong password rejected', r.status >= 400, r.body);
r = await rpc('agent_login', { p_username: username, p_password_hash: sha(pw) });
let sid = r.body?.session_id; ok('member signs in', good(r) && sid, r.body);
r = await rpc('team_validate_session', { p_session_id: sid });
ok('session valid', good(r), r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'list' });
ok('member CAN read products', good(r) && JSON.stringify(r.body).includes(prodId), r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'create', p_values: { name: 'Interdit', price: 1, stock: 1 } });
ok('member CANNOT create product', r.status >= 400, r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'update', p_id: prodId, p_values: { price: 1 } });
ok('member CANNOT change product price', r.status >= 400, r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'clients', p_action: 'list' });
ok('member CANNOT read clients', r.status >= 400, r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'codes_promo', p_action: 'list' });
ok('member CANNOT read coupons', r.status >= 400, r.body);
r = await rpc('agent_get_orders', { p_session_id: sid });
ok('member CAN read orders', good(r) && JSON.stringify(r.body).includes(orderId), r.body);
r = await rpc('mobile_create_order', { p_session_id: sid, p_idempotency_key: key(), p_items: [{ product_id: prodId, quantity: 1 }], p_customer: { client_name: 'Membre Client', client_phone: '+21655000111', city: 'Sfax', address: 'Rue 2' } });
const mOrder = (Array.isArray(r.body) ? r.body[0] : r.body); const mOrderId = mOrder?.order_id ?? mOrder?.id;
ok('member CAN create order', good(r) && mOrderId, r.body);
r = await rpc('agent_update_order', { p_session_id: sid, p_order_id: orderId, p_status: 'tentative_1', p_notes: 'Pas de réponse' });
ok('member CAN update order status', good(r), r.body);
r = await rpc('soft_delete_store_order', { p_order_id: orderId, p_session_id: sid });
ok('member CANNOT delete order', r.status >= 400, r.body);
r = await rpc('team_save_member', { p_store_id: A.storeId, p_values: { name: 'x', username: `y${stamp}`, role: 'admin', status: 'active', permissions: {}, password_hash: sha('x') } }, ANON);
ok('anonymous cannot create members', r.status >= 400, r.body);
r = await rpc('agent_get_orders', { p_session_id: key() });
ok('forged session id rejected', r.status >= 400, r.body);

console.log('\n== Shop B data is invisible to member of shop A');
r = await call('/rest/v1/products', { method: 'POST', token: B.token, headers: { prefer: 'return=representation' }, body: { store_id: B.storeId, name: 'Produit B', price: 10, stock: 3, status: 'active' } });
const prodB = r.body?.[0]?.id;
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'list' });
ok('member never sees shop B products', !JSON.stringify(r.body).includes(prodB), r.body);
r = await rpc('mobile_create_order', { p_session_id: sid, p_store_id: B.storeId, p_idempotency_key: key(), p_items: [{ product_id: prodB, quantity: 1 }], p_customer: { client_name: 'X', client_phone: '+21655000111' } });
ok('member cannot order in shop B', r.status >= 400, r.body);

console.log('\n== Owner changes permissions → takes effect');
r = await rpc('team_save_member', { p_store_id: A.storeId, p_member_id: memberId, p_values: { name: 'Agent Test', username, role: 'orders', status: 'active', permissions: { commandes: { read: true, create: true, modify: true, delete: false }, produits: { read: true, create: true, modify: true, delete: false } } } }, A.token);
ok('owner grants product create/modify', good(r), r.body);
r = await rpc('agent_login', { p_username: username, p_password_hash: sha(pw) }); sid = r.body?.session_id;
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'create', p_values: { name: 'Créé par membre', price: 12, stock: 4 } });
const memberProd = r.body?.id ?? r.body?.[0]?.id;
ok('member now CAN create product', good(r) && memberProd, r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'update', p_id: memberProd, p_values: { price: 14 } });
ok('member now CAN update product', good(r), r.body);
r = await rpc('team_module', { p_session_id: sid, p_module: 'produits', p_action: 'delete', p_id: memberProd });
ok('member still CANNOT delete product', r.status >= 400, r.body);

console.log('\n== Revoke member');
r = await rpc('team_revoke_member', { p_store_id: A.storeId, p_member_id: memberId }, A.token);
ok('owner revokes member', good(r), r.body);
r = await rpc('agent_get_orders', { p_session_id: sid });
ok('revoked session stops working immediately', r.status >= 400, r.body);
r = await rpc('agent_login', { p_username: username, p_password_hash: sha(pw) });
ok('revoked member cannot sign in', r.status >= 400, r.body);

console.log(`\n${pass} passed, ${fails.length} failed`);
fails.forEach(f => console.log(' -', f));
process.exit(fails.length ? 1 : 0);
