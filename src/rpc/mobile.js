import { badRequest, forbidden } from '../lib/errors.js';
import { id, permission, publicStore } from '../lib/commerce.js';
import { loadSession, need } from './agents.js';

export function normalizeScanCode(value) {
  if (typeof value !== 'string' || value.length > 128) throw badRequest('Invalid reference');
  const code = value.trim().replace(/^#/, '');
  if (!/^[A-Za-z0-9._/-]{1,64}$/.test(code)) throw badRequest('Invalid reference');
  return code;
}

export async function scanAccess(args, ctx) {
  // Never choose silently between two credential models.
  if (args.p_session_id != null) {
    if (ctx.userId) throw badRequest('Choose one session model');
    const session = await loadSession(ctx, id(args.p_session_id));
    need(session, 'commandes', 'read');
    if (args.p_store_id != null && id(args.p_store_id) !== session.store_id) throw forbidden('Shop not assigned');
    const store = await publicStore(ctx, session.store_id);
    const sub = await ctx.one('SELECT customer_data_locked FROM public.store_subscriptions WHERE store_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [store.id]);
    return { store, visible: sub?.customer_data_locked !== true };
  }
  const storeId = id(args.p_store_id);
  await permission(ctx, storeId, 'canManageOrders');
  const store = await publicStore(ctx, storeId);
  return { store, visible: await ctx.canViewCustomerData(storeId) };
}

export default {
  async mobile_scan_lookup(args, ctx) {
    const code = normalizeScanCode(args.p_code);
    const { store, visible } = await scanAccess(args, ctx);
    // EXISTS avoids duplicated results when several parcels point to one order.
    // Two rows suffice to reject ambiguity without exposing another customer's data.
    const rows = await ctx.q(`SELECT o.id,o.order_number,o.client_name,o.client_phone,o.region,o.amount,o.currency,o.status,
      COALESCE((SELECT sum(i.quantity) FROM public.order_items i WHERE i.order_id=o.id),o.quantity,0)::int AS item_count
      FROM public.orders o WHERE o.store_id=$1 AND o.deleted_at IS NULL AND (
        lower(o.order_number)=lower($2) OR lower(o.tracking_number)=lower($2) OR EXISTS (
          SELECT 1 FROM public.delivery_shipments s WHERE s.store_id=$1 AND s.order_id=o.id AND lower(s.tracking_number)=lower($2)
        )) ORDER BY o.id LIMIT 2`, [store.id, code]);
    if (rows.length === 0) return { outcome: 'not_found' };
    if (rows.length > 1) return { outcome: 'ambiguous' };
    const order = rows[0];
    return { outcome: 'found', order: {
      id: order.id, order_number: order.order_number,
      client_name: visible ? order.client_name : '••••', client_phone: visible ? order.client_phone : '',
      region: visible ? order.region : '', amount: order.amount, currency: order.currency ?? store.currency,
      status: order.status, item_count: order.item_count,
    } };
  },
};