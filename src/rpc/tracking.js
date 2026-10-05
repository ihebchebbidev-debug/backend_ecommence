import { notFound } from '../lib/errors.js';
import { id, text, phone, publicStore, rateLimit } from '../lib/commerce.js';

export function projectTracking(order, items) {
  const state = {pending:'pending',confirmed:'confirmed',shipped:'shipped',delivered:'delivered',cancelled:'cancelled',canceled:'cancelled',returned:'returned'};
  return {
    order_number:order.order_number,currency:order.currency,
    subtotal:order.merchandise_subtotal ?? Number(order.amount)-Number(order.delivery_fee),
    discount:Number(order.discount_amount ?? 0),delivery:Number(order.delivery_fee),total:Number(order.amount),
    payment_status:order.payment_status === 'paid' ? 'paid' : 'unpaid',
    status:state[order.status] ?? 'processing',created_at:order.created_at,updated_at:order.updated_at,
    tracking_number:order.tracking_number || null,
    items:items.length ? items.map(i=>({name:i.product_name,quantity:i.quantity,total:Number(i.line_total)})) : [{name:order.product_name,quantity:order.quantity,total:Number(order.amount)-Number(order.delivery_fee)}],
  };
}
export default {
  async lookup_public_purchase({p_store_id,p_reference,p_phone},ctx) {
    id(p_store_id);
    await rateLimit(ctx,'tracking',p_store_id,10);
    const fail = () => { throw notFound('Order not found',{code:'TRACKING_NOT_FOUND'}); };
    let reference, normalized;
    try { reference=text(p_reference,40,true); normalized=phone(p_phone); await publicStore(ctx,p_store_id); } catch { return fail(); }
    const candidates=await ctx.q(`SELECT order_number,client_phone,product_name,quantity,currency,amount,delivery_fee,
      merchandise_subtotal,discount_amount,payment_status,status,created_at,updated_at,tracking_number,id
      FROM public.orders WHERE store_id=$1 AND order_number=$2 AND deleted_at IS NULL LIMIT 2`,[p_store_id,reference]);
    const order=candidates.length===1 ? candidates[0] : null;
    try { if (!order || phone(order.client_phone)!==normalized) return fail(); } catch { return fail(); }
    const items=await ctx.q('SELECT product_name,quantity,line_total FROM public.order_items WHERE order_id=$1 ORDER BY created_at,id',[order.id]);
    return projectTracking(order,items);
  },
};
