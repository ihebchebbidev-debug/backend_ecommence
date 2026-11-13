import { createHash } from 'node:crypto';
import { badRequest, forbidden } from './errors.js';
import { id, phone, text, publicStore, rateLimit, priceCheckout } from './commerce.js';
import { recordOrderExperiment } from './experimentPricing.js';

export function captureArgs(args) {
  const storeId = id(args.p_store_id), requestId = id(args.p_checkout_request_id);
  const tel = phone(args.p_phone);
  if (!Array.isArray(args.p_items) || !args.p_items.length || args.p_items.length > 100) throw badRequest('Invalid checkout items');
  // Saved as the shopper typed it (like completed orders), so the seller sees the same number in both tabs.
  const typed = text(args.p_phone, 32, true).replace(/[\s()+.-]/g, '');
  return { storeId, requestId, tel, typed, name: text(args.p_name, 120), items: args.p_items };
}
export async function captureAbandoned(args, ctx) {
  const { storeId, requestId, tel, typed, name, items } = captureArgs(args);
  const store = await publicStore(ctx, storeId);
  await rateLimit(ctx, 'checkout-capture', storeId, 20);
  return ctx.tx(async t => {
    await t.one('SELECT id FROM public.platform_stores WHERE id=$1 FOR UPDATE', [storeId]);
    const prior = await t.one('SELECT id, status FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2', [storeId, requestId]);
    if (prior && prior.status !== 'abandoned') return { saved: true, completed: true };
    const blocked = await t.one(`SELECT EXISTS (SELECT 1 FROM public.phone_blacklist WHERE store_id=$1 AND right(regexp_replace(phone,'\\D','','g'),8)=$2)
      OR EXISTS (SELECT 1 FROM public.ip_blacklist WHERE store_id=$1 AND trim(ip_address)=$3)
      OR EXISTS (SELECT 1 FROM public.clients WHERE store_id=$1 AND status='blacklist' AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),8)=$2) AS blocked`, [storeId, tel.slice(-8), String(ctx.requestIp || '').replace(/^::ffff:/, '')]);
    if (blocked?.blocked) throw forbidden('Order unavailable', { code: 'ORDER_BLOCKED' });
    const quote = await priceCheckout(t, storeId, items, store.currency);
    const first = quote.rows[0]; if (!first) throw badRequest('Product unavailable');
    const fingerprint = createHash('sha256').update(JSON.stringify([items, '', tel])).digest('hex');
    let orderId;
    if (prior) {
      await t.q(`UPDATE public.orders SET client_phone=$3, client_name=$4, product_id=$5, product_name=$6, quantity=$7, amount=$8, checkout_fingerprint=$9, delivery_fee=$10,
          bundle_id=$11, bundle_name=$12, bundle_label=$13, bundle_price=$14, bundle_quantity=$15, updated_at=now()
        WHERE store_id=$1 AND checkout_request_id=$2 AND status='abandoned'`, [storeId, requestId, typed, name, first.product.id, first.product.name, first.qty, quote.total, fingerprint, quote.delivery,
        first.bundle?.id || null, first.bundle?.name || null, first.bundle?.label || null, first.bundlePrice ?? null, first.bundle?.quantity || null]);
      orderId = prior.id;
    } else {
      const seq = await t.one(`INSERT INTO public.store_order_seq(store_id,next_val) VALUES($1,1) ON CONFLICT(store_id) DO UPDATE SET next_val=public.store_order_seq.next_val+1 RETURNING next_val`, [storeId]);
      const row = await t.one(`INSERT INTO public.orders(store_id,order_number,status,client_phone,client_name,product_id,product_name,quantity,amount,currency,checkout_request_id,checkout_fingerprint,delivery_fee,
          bundle_id,bundle_name,bundle_label,bundle_price,bundle_quantity,created_at,updated_at)
        VALUES($1,$2,'abandoned',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now()) RETURNING id`, [storeId, String(seq.next_val).padStart(5,'0'), typed, name, first.product.id, first.product.name, first.qty, quote.total, store.currency, requestId, fingerprint, quote.delivery,
        first.bundle?.id || null, first.bundle?.name || null, first.bundle?.label || null, first.bundlePrice ?? null, first.bundle?.quantity || null]);
      orderId = row.id;
    }
    await recordOrderExperiment(t, orderId, quote);
    // Keep the whole basket (not only its first product) so the seller sees what was left behind.
    // These lines never touch stock: merchandise_subtotal stays empty until the shopper completes the order.
    await t.q('DELETE FROM public.order_items WHERE order_id=$1', [orderId]);
    for (const r of quote.rows) {
      await t.q(`INSERT INTO public.order_items (order_id, product_id, product_name, bundle_id, bundle_name, bundle_label, bundle_price, bundle_quantity, quantity, unit_price, line_total, delivery_fee, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp())`, [orderId, r.product.id, r.product.name, r.bundle?.id || null, r.bundle?.name || null, r.bundle?.label || null,
        r.bundlePrice ?? null, r.bundle?.quantity || null, r.qty, r.unitPrice, r.lineTotal, r.deliveryFee]);
    }
    return { saved: true, completed: false };
  });
}