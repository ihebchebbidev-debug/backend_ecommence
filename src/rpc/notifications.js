import { badRequest, forbidden } from '../lib/errors.js';
import { id, boundedInt } from '../lib/commerce.js';

export async function allowedTypes(ctx, storeId) {
  ctx.requireAuth();
  if (!ctx.userId || !(await ctx.isActiveUser())) throw forbidden('Active user session required');
  await ctx.assertStoreAccess(id(storeId));
  const types = [];
  if (await ctx.hasStorePermission(storeId,'canManageOrders')) types.push('order_created','order_cancelled');
  if (await ctx.hasStorePermission(storeId,'canManagePayments')) types.push('payment_received');
  if (await ctx.hasStorePermission(storeId,'canManageInventory')) types.push('low_stock');
  return types;
}
export default {
  async list_store_notifications({p_store_id,p_limit = 30,p_cursor = null},ctx) {
    const types = await allowedTypes(ctx,p_store_id);
    const limit = boundedInt(p_limit,30);
    let cursor = null;
    if (p_cursor != null) {
      id(p_cursor);
      cursor = await ctx.one('SELECT id,created_at FROM public.commerce_notifications WHERE id=$1 AND store_id=$2 AND type=ANY($3::text[])',[p_cursor,p_store_id,types]);
      if (!cursor) throw badRequest('Invalid feed cursor');
    }
    const cutoff = await ctx.one('SELECT now() AS cutoff');
    const rows = await ctx.q(`SELECT n.id,n.type,n.source_id,n.data,n.created_at,(r.notification_id IS NULL) AS unread
      FROM public.commerce_notifications n LEFT JOIN public.commerce_notification_reads r ON r.notification_id=n.id AND r.user_id=$2
      WHERE n.store_id=$1 AND n.type=ANY($3::text[]) AND n.created_at <= $4
      AND ($5::timestamptz IS NULL OR (n.created_at,n.id)<($5,$6::uuid))
      ORDER BY n.created_at DESC,n.id DESC LIMIT $7`,[p_store_id,ctx.userId,types,cutoff.cutoff,cursor?.created_at ?? null,cursor?.id ?? null,limit+1]);
    const count = await ctx.one(`SELECT count(*)::int AS count FROM public.commerce_notifications n
      WHERE n.store_id=$1 AND n.type=ANY($3::text[]) AND NOT EXISTS
      (SELECT 1 FROM public.commerce_notification_reads r WHERE r.notification_id=n.id AND r.user_id=$2)`,[p_store_id,ctx.userId,types]);
    return {items:rows.slice(0,limit),next_cursor:rows.length>limit ? rows[limit-1].id : null,unread_count:count?.count ?? 0,cutoff:cutoff.cutoff};
  },
  async mark_store_notification_read({p_store_id,p_notification_id},ctx) {
    const types = await allowedTypes(ctx,p_store_id);
    const n = await ctx.one('SELECT id FROM public.commerce_notifications WHERE id=$1 AND store_id=$2 AND type=ANY($3::text[])',[id(p_notification_id),p_store_id,types]);
    if (!n) throw forbidden('Notification unavailable');
    await ctx.q('INSERT INTO public.commerce_notification_reads(notification_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[n.id,ctx.userId]);
    return true;
  },
  async mark_store_notifications_read({p_store_id,p_cutoff},ctx) {
    const types = await allowedTypes(ctx,p_store_id);
    if (typeof p_cutoff !== 'string' || !Number.isFinite(Date.parse(p_cutoff)) || Date.parse(p_cutoff)>Date.now()+1000) throw badRequest('Invalid feed cutoff');
    await ctx.q(`INSERT INTO public.commerce_notification_reads(notification_id,user_id)
      SELECT id,$2 FROM public.commerce_notifications WHERE store_id=$1 AND type=ANY($3::text[]) AND created_at <= $4 AND created_at <= now()
      ON CONFLICT DO NOTHING`,[p_store_id,ctx.userId,types,p_cutoff]);
    return true;
  },
};
