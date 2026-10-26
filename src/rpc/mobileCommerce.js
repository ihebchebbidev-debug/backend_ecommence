// Mobile manual orders and order product editing, priced by the same server checkout
// pricing as the storefront (priceCheckout): products, bundles, offers, shop delivery,
// coupons and finite stock are never computed by the phone.
import { badRequest, ApiError } from '../lib/errors.js';
import { id, text, couponCode, priceCheckout, major, money } from '../lib/commerce.js';
import { orderActor, idempotencyKey, once, setActor } from './mobileOrders.js';
import { ALL_PLANS_UNLOCKED } from './billing.js';

const conflict = (message, code) => new ApiError(409, message, { code });
// Products can still change before the parcel leaves.
export const ITEMS_EDITABLE = ['pending', 'confirmed', 'tentative_1', 'tentative_2', 'answered', 'attempt1', 'attempt2'];

export function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw badRequest('Invalid items');
  return items.map(item => {
    if (!item || typeof item !== 'object') throw badRequest('Invalid items');
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw badRequest('Invalid quantity');
    return item.bundle_id ? { product_id: id(item.product_id), bundle_id: id(item.bundle_id), bundle_count: qty } : { product_id: id(item.product_id), quantity: qty };
  });
}

function cleanCustomer(c) {
  if (!c || typeof c !== 'object') throw badRequest('Invalid customer');
  const out = { name: text(c.client_name ?? '', 120), phone: text(c.client_phone ?? '', 32), city: text(c.city ?? '', 120), address: text(c.address ?? '', 300), notes: text(c.notes ?? '', 2000) };
  if (!out.name) throw badRequest('Client name required');
  if (!/^\+?[0-9 ()-]{6,32}$/.test(out.phone)) throw badRequest('Invalid phone');
  return out;
}

async function shopCurrency(t, storeId) {
  const shop = await t.one('SELECT currency FROM public.platform_stores WHERE id=$1', [storeId]);
  return String(shop?.currency || 'TND').trim().toUpperCase();
}

/** A coupon already used on an order stays applied with its own type and value, even if it expired since. */
export function keptDiscount(coupon, baseMinor, currency) {
  if (!coupon) return 0;
  const value = money(coupon.value, coupon.type === 'percentage' ? 'TND' : currency);
  if (coupon.type === 'percentage') return Math.min(baseMinor, Number((BigInt(baseMinor) * BigInt(Math.min(value, 100000)) + 50000n) / 100000n));
  return Math.min(baseMinor, value);
}

function summary(quote) {
  return {
    items: quote.rows.map(r => ({ product_id: r.product.id, product_name: r.product.name, bundle_id: r.bundle?.id ?? null, bundle_name: r.bundle?.label || r.bundle?.name || null, quantity: r.count, unit_price: r.bundlePrice ?? r.unitPrice, line_total: r.lineTotal })),
    subtotal: quote.subtotal, offer_discount: quote.offerDiscount, discount: quote.discount, delivery: quote.delivery, total: quote.total, currency: quote.currency,
  };
}

async function writeItems(t, orderId, quote, currency) {
  for (const r of quote.rows) {
    await t.q(`INSERT INTO public.order_items (order_id, product_id, product_name, bundle_id, bundle_name, bundle_label, bundle_price, bundle_quantity, quantity, unit_price, line_total, delivery_fee, discount_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [orderId, r.product.id, r.product.name, r.bundle?.id || null, r.bundle?.name || null, r.bundle?.label || null, r.bundlePrice, r.bundle?.quantity || null, r.qty, r.unitPrice, r.lineTotal, r.deliveryFee, major(r.discountMinor, currency)]);
  }
  for (const { product, required } of quote.stock.values()) {
    if (product.stock != null) await t.q('UPDATE public.products SET stock = stock - $2 WHERE id = $1', [product.id, required]);
  }
  await t.q('UPDATE public.orders SET offer_discount=$2, offer_snapshot=$3::jsonb WHERE id=$1', [orderId, quote.offerDiscount, JSON.stringify(quote.offers)]);
}

export default {
  /** Read-only price preview for the manual order and product edit screens. */
  async mobile_quote_order(args, ctx) {
    const actor = await orderActor(args, ctx, 'read');
    const items = cleanItems(args.p_items);
    const code = couponCode(args.p_coupon ?? '');
    const currency = await shopCurrency(ctx, actor.storeId);
    return summary(await priceCheckout(ctx, actor.storeId, items, currency, code, false));
  },

  async mobile_create_order(args, ctx) {
    const actor = await orderActor(args, ctx, 'create');
    const key = idempotencyKey(args.p_idempotency_key);
    const items = cleanItems(args.p_items);
    const customer = cleanCustomer(args.p_customer);
    const code = couponCode(args.p_coupon ?? '');
    return ctx.tx(async t => once(t, actor.storeId, key, 'order_create', async () => {
      await setActor(t, actor);
      const currency = await shopCurrency(t, actor.storeId);
      const quote = await priceCheckout(t, actor.storeId, items, currency, code, true);
      if (code && !ALL_PLANS_UNLOCKED) {
        const plan = await t.one(`SELECT coalesce(o.is_enabled,pl.has_coupons,false) AS allowed FROM public.platform_stores s
          LEFT JOIN public.store_feature_overrides o ON o.store_id=s.id AND o.feature_key='has_coupons'
          LEFT JOIN LATERAL (SELECT has_coupons FROM public.plan_limits WHERE plan_id=s.plan_id OR plan=s.subscription_plan ORDER BY (plan_id=s.plan_id) DESC LIMIT 1) pl ON true WHERE s.id=$1`, [actor.storeId]);
        if (!plan?.allowed) throw badRequest('Coupon unavailable', { code: 'COUPON_INVALID' });
      }
      let client = await t.one('SELECT id FROM public.clients WHERE store_id=$1 AND phone=$2 LIMIT 1', [actor.storeId, customer.phone]);
      if (!client) client = await t.one(`INSERT INTO public.clients (store_id, name, phone, city, note) VALUES ($1,$2,$3,$4,'') RETURNING id`, [actor.storeId, customer.name, customer.phone, customer.city]);
      const seq = await t.one(`INSERT INTO public.store_order_seq (store_id, next_val) VALUES ($1, 1)
        ON CONFLICT (store_id) DO UPDATE SET next_val = public.store_order_seq.next_val + 1 RETURNING next_val`, [actor.storeId]);
      const first = quote.rows[0];
      const order = await t.one(`INSERT INTO public.orders (store_id, order_number, client_id, client_name, client_phone, product_id, product_name, quantity, amount, delivery_fee, currency, status,
          bundle_id, bundle_name, bundle_label, bundle_price, bundle_quantity, payment_provider, address, city, merchandise_subtotal, discount_amount, coupon_code, notes, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14,$15,$16,'manual',$17,$18,$19,$20,$21,$22, now(), now()) RETURNING id, order_number, amount`,
        [actor.storeId, String(seq.next_val).padStart(5, '0'), client.id, customer.name, customer.phone, first.product.id, first.product.name, first.qty, quote.total, quote.delivery, currency,
          first.bundle?.id || null, first.bundle?.name || null, first.bundle?.label || null, first.bundlePrice, first.bundle?.quantity || null,
          customer.address, customer.city, quote.subtotal, quote.discount, quote.coupon ? code : null, customer.notes]);
      await writeItems(t, order.id, quote, currency);
      if (quote.coupon) {
        await t.q('UPDATE public.coupons SET used_count = used_count + 1 WHERE id = $1', [quote.coupon.id]);
        await t.q('INSERT INTO public.coupon_redemptions (order_id, coupon_id, store_id, code, discount_amount) VALUES ($1,$2,$3,$4,$5)', [order.id, quote.coupon.id, actor.storeId, code, quote.discount]);
      }
      return { order_id: order.id, order_number: order.order_number, total: Number(order.amount) };
    }));
  },

  /** Replaces an order's products, repriced on the server; a coupon already used stays applied. */
  async mobile_set_order_items(args, ctx) {
    const actor = await orderActor(args, ctx, 'modify');
    const key = idempotencyKey(args.p_idempotency_key);
    const orderId = id(args.p_order_id);
    const items = cleanItems(args.p_items);
    return ctx.tx(async t => once(t, actor.storeId, key, 'order_items', async () => {
      await setActor(t, actor);
      const order = await t.one('SELECT id, status, currency, updated_at, merchandise_subtotal, coupon_code FROM public.orders WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL FOR UPDATE', [orderId, actor.storeId]);
      if (!order) throw badRequest('Order not found');
      if (args.p_expected_updated_at != null && new Date(order.updated_at).toISOString() !== new Date(args.p_expected_updated_at).toISOString()) throw conflict('Order changed', 'STALE_ORDER');
      if (!ITEMS_EDITABLE.includes(order.status)) throw conflict('Order can no longer change products', 'ORDER_LOCKED');
      const parcel = await t.one(`SELECT id FROM public.delivery_shipments WHERE order_id=$1 AND COALESCE(status,'') NOT IN ('cancelled','canceled','failed') LIMIT 1`, [orderId]);
      if (parcel) throw conflict('Cancel the parcel first', 'already_shipped');
      const currency = String(order.currency || await shopCurrency(t, actor.storeId)).trim().toUpperCase();
      // Return the stock this order reserved before pricing the new basket.
      if (order.merchandise_subtotal != null) {
        await t.q(`UPDATE public.products p SET stock = p.stock + i.qty FROM (SELECT product_id, sum(quantity)::int AS qty FROM public.order_items WHERE order_id=$1 GROUP BY product_id) i
          WHERE p.id = i.product_id AND p.stock IS NOT NULL`, [orderId]);
      }
      await t.q('DELETE FROM public.order_items WHERE order_id=$1', [orderId]);
      const quote = await priceCheckout(t, actor.storeId, items, currency, '', true);
      const redemption = await t.one('SELECT coupon_id FROM public.coupon_redemptions WHERE order_id=$1 LIMIT 1', [orderId]);
      const coupon = redemption ? await t.one('SELECT type, value::text FROM public.coupons WHERE id=$1', [redemption.coupon_id]) : null;
      const base = money(String(quote.subtotal), currency) - money(String(quote.offerDiscount), currency);
      const discountMinor = keptDiscount(coupon, base, currency);
      if (discountMinor) { const last = quote.rows[quote.rows.length - 1]; last.discountMinor += discountMinor; last.lineTotal = major(last.lineMinor - last.discountMinor, currency); }
      const discount = major(discountMinor, currency), total = major(base - discountMinor + money(String(quote.delivery), currency), currency);
      await writeItems(t, orderId, quote, currency);
      const first = quote.rows[0];
      const row = await t.one(`UPDATE public.orders SET product_id=$2, product_name=$3, quantity=$4, amount=$5, delivery_fee=$6, merchandise_subtotal=$7, discount_amount=$8,
          bundle_id=$9, bundle_name=$10, bundle_label=$11, bundle_price=$12, bundle_quantity=$13, updated_at=now() WHERE id=$1 RETURNING id, amount, updated_at`,
        [orderId, first.product.id, first.product.name, quote.rows.reduce((s, r) => s + r.qty, 0), total, quote.delivery, quote.subtotal, discount,
          first.bundle?.id || null, first.bundle?.name || null, first.bundle?.label || null, first.bundlePrice, first.bundle?.quantity || null]);
      return { order_id: row.id, total: Number(row.amount), discount, updated_at: row.updated_at };
    }));
  },
};
