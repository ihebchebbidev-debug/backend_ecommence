import { createHash } from 'node:crypto';
import { badRequest, forbidden } from './errors.js';
import { id, phone, text, publicStore, rateLimit, priceCheckout } from './commerce.js';

export function captureArgs(args) {
  const storeId = id(args.p_store_id), requestId = id(args.p_checkout_request_id);
  const tel = phone(args.p_phone);
  if (!Array.isArray(args.p_items) || !args.p_items.length || args.p_items.length > 100) throw badRequest('Invalid checkout items');
  return { storeId, requestId, tel, name: text(args.p_name, 120), items: args.p_items };
}
export async function captureAbandoned(args, ctx) {
  const { storeId, requestId, tel, name, items } = captureArgs(args);
  const store = await publicStore(ctx, storeId);
  await rateLimit(ctx, 'checkout-capture', storeId, 20);
  return ctx.tx(async t => {
    await t.one('SELECT id FROM public.platform_stores WHERE id=$1 FOR UPDATE', [storeId]);
    const prior = await t.one('SELECT id, status FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2', [storeId, requestId]);
    if (prior && prior.status !== 'abandoned') return { saved: true, completed: true };
    const blocked = await t.one(`SELECT EXISTS (SELECT 1 FROM public.phone_blacklist WHERE store_id=$1 AND right(regexp_replace(phone,'\\D','','g'),8)=$2)
      OR EXISTS (SELECT 1 FROM public.ip_blacklist WHERE store_id=$1 AND trim(ip_address)=$3) AS blocked`, [storeId, tel.slice(-8), String(ctx.requestIp || '').replace(/^::ffff:/, '')]);
    if (blocked?.blocked) throw forbidden('Order unavailable', { code: 'ORDER_BLOCKED' });
    const quote = await priceCheckout(t, storeId, items, store.currency);
    const first = quote.rows[0]; if (!first) throw badRequest('Product unavailable');
    const fingerprint = createHash('sha256').update(JSON.stringify([items, '', tel])).digest('hex');
    if (prior) {
      await t.q(`UPDATE public.orders SET client_phone=$3, client_name=$4, product_id=$5, product_name=$6, quantity=$7, amount=$8, checkout_fingerprint=$9, updated_at=now()
        WHERE store_id=$1 AND checkout_request_id=$2 AND status='abandoned'`, [storeId, requestId, tel, name, first.product.id, first.product.name, first.qty, quote.total, fingerprint]);
    } else {
      const seq = await t.one(`INSERT INTO public.store_order_seq(store_id,next_val) VALUES($1,1) ON CONFLICT(store_id) DO UPDATE SET next_val=public.store_order_seq.next_val+1 RETURNING next_val`, [storeId]);
      await t.q(`INSERT INTO public.orders(store_id,order_number,status,client_phone,client_name,product_id,product_name,quantity,amount,currency,checkout_request_id,checkout_fingerprint,created_at,updated_at)
        VALUES($1,$2,'abandoned',$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())`, [storeId, String(seq.next_val).padStart(5,'0'), tel, name, first.product.id, first.product.name, first.qty, quote.total, store.currency, requestId, fingerprint]);
    }
    return { saved: true, completed: false };
  });
}