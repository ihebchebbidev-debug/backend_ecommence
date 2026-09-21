// SQL RPC functions: products (spec 3.6).
import { forbidden } from '../lib/errors.js';

export default {
  async get_top_products({ p_store_id, p_limit = 3 }, ctx) {
    if (!ctx.isServiceRole) {
      const storeIds = await ctx.userStoreIds();
      const superAdmin = await ctx.isSuperAdmin();
      if (!superAdmin && !storeIds.includes(p_store_id)) throw forbidden('Accès refusé');
    }
    return ctx.q(
      `WITH ranked AS (
         SELECT o.product_id AS pid, COUNT(*) AS cnt
         FROM public.orders o
         WHERE o.store_id = $1 AND o.product_id IS NOT NULL
         GROUP BY o.product_id
       )
       SELECT pr.id, pr.name, pr.price, pr.image_url, COALESCE(r.cnt, 0)::int AS order_count
       FROM public.products pr
       LEFT JOIN ranked r ON r.pid = pr.id
       WHERE pr.store_id = $1 AND COALESCE(pr.status, 'active') = 'active'
       ORDER BY r.cnt DESC NULLS LAST, pr.name ASC
       LIMIT $2`,
      [p_store_id, p_limit],
    );
  },
};
