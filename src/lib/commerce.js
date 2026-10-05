import { createHash } from 'node:crypto';
import { badRequest, forbidden, ApiError } from './errors.js';

export function id(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw badRequest('Invalid identifier');
  return value;
}
export function boundedInt(value, fallback, max = 100) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest('Invalid quantity or limit');
  return n;
}
export function text(value, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw badRequest('Invalid text field');
  return value.trim();
}
export function phone(value) {
  let n = text(value, 32, true).replace(/[\s()+.-]/g, '');
  if (!/^\d{8,15}$/.test(n)) throw badRequest('Invalid phone');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.length === 8) n = `216${n}`;
  return n;
}
export async function permission(ctx, storeId, key) {
  ctx.requireAuth();
  if (!ctx.userId) throw forbidden('A user session is required');
  if (!(await ctx.isActiveUser())) throw forbidden('Account unavailable');
  await ctx.assertStoreAccess(id(storeId));
  if (!(await ctx.hasStorePermission(storeId, key))) throw forbidden('Insufficient permission');
}
export async function publicStore(db, storeId, currency = null) {
  const store = await db.one('SELECT id, status, deleted_at, currency FROM public.platform_stores WHERE id = $1', [id(storeId)]);
  if (!store || store.deleted_at || store.status !== 'active') throw forbidden('Store unavailable');
  if (currency != null && currency !== store.currency) throw badRequest('Currency does not match store');
  return store;
}
// Exact decimal -> minor units, with half-up rounding. TND has three decimal places.
export function money(value, currency = 'TND') {
  const digits = currency === 'TND' ? 3 : ['JPY','KRW'].includes(currency) ? 0 : 2;
  const s = String(value ?? 0);
  if (!/^\d+(\.\d+)?$/.test(s)) throw badRequest('Invalid monetary value');
  const [whole, fraction = ''] = s.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt((fraction + '0'.repeat(digits)).slice(0, digits) || '0') + (Number(fraction[digits] ?? 0) >= 5 ? 1n : 0n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('Monetary value too large');
  return Number(minor);
}
export function major(value, currency) { return value / (currency === 'TND' ? 1000 : ['JPY','KRW'].includes(currency) ? 1 : 100); }
export function couponCode(value) {
  const code = text(value, 40).toUpperCase();
  if (code && !/^[A-Z0-9_-]{1,40}$/.test(code)) throw badRequest('Invalid coupon code', { code: 'COUPON_INVALID' });
  return code;
}
export function discountFor(coupon, subtotal, currency, now = new Date()) {
  const fail = code => { throw badRequest('Coupon unavailable', { code }); };
  if (!coupon) fail('COUPON_INVALID');
  if (!coupon.active) fail('COUPON_INACTIVE');
  if (coupon.starts_at && new Date(coupon.starts_at) > now) fail('COUPON_NOT_STARTED');
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) fail('COUPON_EXPIRED');
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) fail('COUPON_USAGE_EXHAUSTED');
  if (subtotal < money(coupon.min_order_amount, currency)) fail('COUPON_MINIMUM_NOT_MET');
  const value = money(coupon.value, coupon.type === 'percentage' ? 'TND' : currency);
  if (coupon.type === 'percentage') {
    if (value > 100000) fail('COUPON_INVALID');
    return Math.min(subtotal, Number((BigInt(subtotal) * BigInt(value) + 50000n) / 100000n));
  }
  if (coupon.type !== 'fixed') fail('COUPON_INVALID');
  return Math.min(subtotal, value);
}
export async function rateLimit(ctx, scope, storeId, max = 20) {
  // Persisted counters shared by all workers; raw IP/phone never stored.
  const identity = createHash('sha256').update(`${scope}:${storeId}:${ctx.requestIp || 'unknown'}`).digest('hex');
  const row = await ctx.one(`INSERT INTO public.commerce_attempts (key, window_start, attempts)
    VALUES ($1, date_trunc('minute', now()), 1)
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN commerce_attempts.window_start < date_trunc('minute',now()) THEN 1 ELSE commerce_attempts.attempts + 1 END,
      window_start = date_trunc('minute',now()) RETURNING attempts`, [identity]);
  if (row.attempts > max) throw new ApiError(429, 'Too many attempts. Retry in 60 seconds.', { code: 'RATE_LIMITED', hint: '60' });
}
export async function priceCheckout(db, storeId, items, currency, code = '', lock = false) {
  await publicStore(db, storeId, currency);
  if (!Array.isArray(items) || !items.length || items.length > 100) throw badRequest('Invalid checkout items');
  const rows = [];
  const stock = new Map();
  // Stable lock order avoids product deadlocks between competing baskets.
  for (const item of [...items].sort((a,b) => String(a.product_id).localeCompare(String(b.product_id)))) {
    const product = await db.one(`SELECT id, name, price::text, delivery_fee::text, stock FROM public.products WHERE id=$1 AND store_id=$2${lock ? ' FOR UPDATE' : ''}`, [id(item.product_id),storeId]);
    if (!product) throw badRequest('Product unavailable');
    let bundle = null;
    if (item.bundle_id) {
      bundle = await db.one(`SELECT id,name,label,price::text,quantity,delivery_fee::text FROM public.product_bundles WHERE id=$1 AND product_id=$2${lock ? ' FOR SHARE' : ''}`,[id(item.bundle_id),product.id]);
      if (!bundle) throw badRequest('Bundle unavailable');
    }
    // Legacy frontend quantity meant pieces for bundles; explicit bundle_count removes ambiguity.
    const count = bundle ? boundedInt(item.bundle_count, 1, 1000) : boundedInt(item.quantity, 1, 1000);
    const qty = bundle ? boundedInt(bundle.quantity, 1, 1000) * count : count;
    const unitMinor = money(bundle?.price ?? product.price,currency);
    const lineMinor = unitMinor * count;
    const deliveryMinor = money(bundle?.delivery_fee ?? product.delivery_fee,currency);
    if (!Number.isSafeInteger(lineMinor)) throw badRequest('Total too large');
    const required = (stock.get(product.id)?.required ?? 0) + qty;
    stock.set(product.id,{product,required});
    if (product.stock != null && product.stock < required) throw badRequest('Insufficient stock',{code:'OUT_OF_STOCK'});
    rows.push({product,bundle,qty,count,unitPrice:major(bundle ? unitMinor / bundle.quantity : unitMinor,currency),bundlePrice:bundle ? major(unitMinor,currency) : null,lineMinor,deliveryMinor});
  }
  const subtotal = rows.reduce((s,r)=>s+r.lineMinor,0);
  const delivery = rows.reduce((s,r)=>s+r.deliveryMinor,0);
  let coupon = null, discount = 0;
  if (code) {
    const matches = await db.q(`SELECT *, value::text,min_order_amount::text FROM public.coupons WHERE store_id=$1 AND upper(trim(code))=$2${lock ? ' FOR UPDATE' : ''}`,[storeId,couponCode(code)]);
    if (matches.length !== 1) throw badRequest('Coupon unavailable',{code:'COUPON_INVALID'});
    coupon = matches[0];
    discount = discountFor(coupon,subtotal,currency);
  }
  // Allocate rounding remainder to the last line, keeping sum(discounts) exact.
  let allocated = 0;
  rows.forEach((r,i)=>{
    r.discountMinor = i === rows.length-1 ? discount-allocated : subtotal ? Number(BigInt(discount)*BigInt(r.lineMinor)/BigInt(subtotal)) : 0;
    allocated += r.discountMinor;
    r.lineTotal = major(r.lineMinor-r.discountMinor,currency);
    r.deliveryFee = major(r.deliveryMinor,currency);
  });
  return {rows,stock,coupon,subtotal:major(subtotal,currency),discount:major(discount,currency),delivery:major(delivery,currency),total:major(subtotal-discount+delivery,currency),currency};
}
