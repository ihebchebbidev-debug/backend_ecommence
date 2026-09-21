// 3.11 Admin Functions — all require super_admin (these replace SECURITY DEFINER
// functions that were locked down to the platform admin role via RLS).
import { forbidden } from '../lib/errors.js';

async function requireSuperAdmin(ctx) {
  ctx.requireAuth();
  if (!(await ctx.isSuperAdmin())) throw forbidden('Super admin access required');
}

async function logAdminAction(ctx, action, { targetStoreId = null, targetUserId = null, details = {} } = {}) {
  await ctx.q(
    `INSERT INTO public.admin_audit_logs (action, performed_by, target_store_id, target_user_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [action, ctx.userId, targetStoreId, targetUserId, details],
  );
}

/** Store ids owned by `userId`, excluding `keepStoreId`. */
async function siblingStoreIds(ctx, userId, keepStoreId) {
  const rows = await ctx.q(
    'SELECT id FROM public.platform_stores WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL',
    [userId, keepStoreId],
  );
  return rows.map((r) => r.id);
}

export default {
  /** admin_store_ownership_diagnostic() → diagnostic rows across every store. */
  async admin_store_ownership_diagnostic(_args, ctx) {
    await requireSuperAdmin(ctx);
    return ctx.q(
      `SELECT
         s.id AS store_id,
         s.store_name,
         s.user_id AS store_user_id,
         p.id AS profile_id,
         p.email AS profile_email,
         u.email AS auth_email,
         s.status,
         s.quarantine_reason,
         EXISTS (
           SELECT 1 FROM public.store_members m
           WHERE m.store_id = s.id AND m.user_id = s.user_id AND m.role = 'owner'
         ) AS has_owner_member,
         (SELECT count(*) FROM public.orders o WHERE o.store_id = s.id) AS orders_count,
         CASE
           WHEN s.user_id IS NULL THEN 'no_owner'
           WHEN p.id IS NULL THEN 'missing_profile'
           WHEN u.id IS NULL THEN 'missing_auth_user'
           ELSE 'ok'
         END AS issue
       FROM public.platform_stores s
       LEFT JOIN public.profiles p ON p.id = s.user_id
       LEFT JOIN auth.users u ON u.id = s.user_id
       WHERE s.deleted_at IS NULL
       ORDER BY s.created_at DESC`,
    );
  },

  /** admin_cleanup_preview(p_keep_store_id) → counts of what would be deleted. */
  async admin_cleanup_preview({ p_keep_store_id }, ctx) {
    await requireSuperAdmin(ctx);
    const keep = await ctx.one('SELECT id, store_name, user_id FROM public.platform_stores WHERE id = $1', [
      p_keep_store_id,
    ]);
    if (!keep) throw forbidden('Store not found');

    const siblingIds = await siblingStoreIds(ctx, keep.user_id, keep.id);
    const totalStores = await ctx.one('SELECT count(*) AS n FROM public.platform_stores WHERE user_id = $1', [
      keep.user_id,
    ]);

    const countFor = async (table, extra = '') => {
      if (siblingIds.length === 0) return 0;
      const row = await ctx.one(
        `SELECT count(*) AS n FROM public.${table} WHERE store_id = ANY($1::uuid[]) ${extra}`,
        [siblingIds],
      );
      return Number(row?.n ?? 0);
    };

    const orphanOrders = await ctx.one(
      `SELECT count(*) AS n FROM public.orders o
       WHERE NOT EXISTS (SELECT 1 FROM public.platform_stores s WHERE s.id = o.store_id)`,
    );
    const orphanProducts = await ctx.one(
      `SELECT count(*) AS n FROM public.products pr
       WHERE NOT EXISTS (SELECT 1 FROM public.platform_stores s WHERE s.id = pr.store_id)`,
    );

    const integrations =
      (await countFor('store_delivery_integrations')) + (await countFor('store_payment_integrations'));

    return [
      {
        keep_store_id: keep.id,
        keep_store_name: keep.store_name,
        total_stores: Number(totalStores?.n ?? 0),
        stores_to_delete: siblingIds.length,
        categories_to_delete: await countFor('categories'),
        clients_to_delete: await countFor('clients'),
        products_to_delete: await countFor('products'),
        orders_to_delete: await countFor('orders'),
        shipments_to_delete: await countFor('shipments'),
        members_to_delete: await countFor('store_members'),
        subscriptions_to_delete: await countFor('store_subscriptions'),
        wallets_to_delete: await countFor('store_wallets'),
        tracking_events_to_delete: await countFor('delivery_tracking_events'),
        integrations_to_delete: integrations,
        orphan_orders: Number(orphanOrders?.n ?? 0),
        orphan_products: Number(orphanProducts?.n ?? 0),
      },
    ];
  },

  /** admin_cleanup_keep_principal_store(p_keep_store_id, confirm_text, delete_orphan_data?) → deletion counts. */
  async admin_cleanup_keep_principal_store({ p_keep_store_id, confirm_text, delete_orphan_data }, ctx) {
    await requireSuperAdmin(ctx);
    if (confirm_text !== 'DELETE') {
      throw forbidden('confirm_text must be "DELETE" to proceed');
    }
    const keep = await ctx.one('SELECT id, store_name, user_id FROM public.platform_stores WHERE id = $1', [
      p_keep_store_id,
    ]);
    if (!keep) throw forbidden('Store not found');

    return ctx.tx(async (t) => {
      const siblingRows = await t.q(
        'SELECT id FROM public.platform_stores WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL',
        [keep.user_id, keep.id],
      );
      const siblingIds = siblingRows.map((r) => r.id);

      const deleteFor = async (table) => {
        if (siblingIds.length === 0) return 0;
        const rows = await t.q(`DELETE FROM public.${table} WHERE store_id = ANY($1::uuid[]) RETURNING 1`, [
          siblingIds,
        ]);
        return rows.length;
      };

      const deletedCategories = await deleteFor('categories');
      const deletedClients = await deleteFor('clients');
      const deletedShipments = await deleteFor('shipments');
      const deletedOrders = await deleteFor('orders');
      const deletedProducts = await deleteFor('products');
      const deletedIntegrations =
        (await deleteFor('store_delivery_integrations')) + (await deleteFor('store_payment_integrations'));

      let deletedStores = 0;
      if (siblingIds.length > 0) {
        const rows = await t.q(
          `UPDATE public.platform_stores SET deleted_at = now() WHERE id = ANY($1::uuid[]) RETURNING 1`,
          [siblingIds],
        );
        deletedStores = rows.length;
      }

      let deletedOrphanOrders = 0;
      let deletedOrphanProducts = 0;
      if (delete_orphan_data) {
        const oo = await t.q(
          `DELETE FROM public.orders o WHERE NOT EXISTS
             (SELECT 1 FROM public.platform_stores s WHERE s.id = o.store_id) RETURNING 1`,
        );
        deletedOrphanOrders = oo.length;
        const op = await t.q(
          `DELETE FROM public.products p WHERE NOT EXISTS
             (SELECT 1 FROM public.platform_stores s WHERE s.id = p.store_id) RETURNING 1`,
        );
        deletedOrphanProducts = op.length;
      }

      await t.q(
        `INSERT INTO public.admin_audit_logs (action, performed_by, target_store_id, target_user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'admin_cleanup_keep_principal_store',
          ctx.userId,
          keep.id,
          keep.user_id,
          { deleted_stores: siblingIds, delete_orphan_data: !!delete_orphan_data },
        ],
      );

      return [
        {
          result_keep_store_id: keep.id,
          keep_store_name: keep.store_name,
          deleted_stores_count: deletedStores,
          deleted_categories_count: deletedCategories,
          deleted_clients_count: deletedClients,
          deleted_products_count: deletedProducts,
          deleted_orders_count: deletedOrders,
          deleted_shipments_count: deletedShipments,
          deleted_integrations_count: deletedIntegrations,
          deleted_orphan_orders_count: deletedOrphanOrders,
          deleted_orphan_products_count: deletedOrphanProducts,
        },
      ];
    });
  },

  /** admin_repair_store_ownership(target_auth_uid, target_email, confirm?) → { action, store_id, store_name }[] */
  async admin_repair_store_ownership({ target_auth_uid, target_email, confirm }, ctx) {
    await requireSuperAdmin(ctx);
    const user = await ctx.one('SELECT id, email FROM auth.users WHERE id = $1', [target_auth_uid]);
    if (!user) throw forbidden('Target auth user not found');

    const orphanStores = await ctx.q(
      `SELECT s.id, s.store_name FROM public.platform_stores s
       WHERE s.deleted_at IS NULL AND (
         s.user_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id)
       )`,
    );

    if (!confirm) {
      return orphanStores.map((s) => ({ action: 'would_repair', store_id: s.id, store_name: s.store_name }));
    }

    return ctx.tx(async (t) => {
      await t.q(
        `INSERT INTO public.profiles (id, email) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        [target_auth_uid, target_email ?? user.email ?? ''],
      );

      const results = [];
      for (const s of orphanStores) {
        await t.q('UPDATE public.platform_stores SET user_id = $1 WHERE id = $2', [target_auth_uid, s.id]);
        results.push({ action: 'repaired', store_id: s.id, store_name: s.store_name });
      }

      await t.q(
        `INSERT INTO public.admin_audit_logs (action, performed_by, target_user_id, details)
         VALUES ($1, $2, $3, $4)`,
        ['admin_repair_store_ownership', ctx.userId, target_auth_uid, { repaired: results.map((r) => r.store_id) }],
      );

      return results;
    });
  },

  /** admin_remediate_orphan_orders(p_store_id, p_action, p_performed_by, p_orphan_order_ids?) → { action, affected_orders }[] */
  async admin_remediate_orphan_orders({ p_store_id, p_action, p_performed_by, p_orphan_order_ids }, ctx) {
    await requireSuperAdmin(ctx);

    const idFilter = p_orphan_order_ids && p_orphan_order_ids.length > 0;
    const baseCondition = idFilter
      ? 'id = ANY($1::uuid[])'
      : `NOT EXISTS (SELECT 1 FROM public.platform_stores s WHERE s.id = orders.store_id)`;
    const baseParams = idFilter ? [p_orphan_order_ids] : [];

    let affected = 0;
    if (p_action === 'assign') {
      const rows = await ctx.q(
        `UPDATE public.orders SET store_id = $${baseParams.length + 1}
         WHERE ${baseCondition} RETURNING 1`,
        [...baseParams, p_store_id],
      );
      affected = rows.length;
    } else if (p_action === 'delete') {
      const rows = await ctx.q(`DELETE FROM public.orders WHERE ${baseCondition} RETURNING 1`, baseParams);
      affected = rows.length;
    } else {
      throw forbidden(`Unsupported action: ${p_action}`);
    }

    await logAdminAction(ctx, 'admin_remediate_orphan_orders', {
      targetStoreId: p_store_id,
      targetUserId: p_performed_by,
      details: { action: p_action, affected, order_ids: p_orphan_order_ids ?? null },
    });

    return [{ action: p_action, affected_orders: affected }];
  },

  /** admin_orphan_orders_diagnostic() → { total_orders, orders_without_store_id, orders_with_deleted_store }[] */
  async admin_orphan_orders_diagnostic(_args, ctx) {
    await requireSuperAdmin(ctx);
    const row = await ctx.one(
      `SELECT
         (SELECT count(*) FROM public.orders) AS total_orders,
         (SELECT count(*) FROM public.orders WHERE store_id IS NULL) AS orders_without_store_id,
         (SELECT count(*) FROM public.orders o
            WHERE o.store_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.platform_stores s WHERE s.id = o.store_id AND s.deleted_at IS NOT NULL)
         ) AS orders_with_deleted_store`,
    );
    return [row];
  },

  /** admin_cascade_soft_delete_user_stores(p_target_user_id, p_performed_by) → { store_id, store_name, orders_count, action }[] */
  async admin_cascade_soft_delete_user_stores({ p_target_user_id, p_performed_by }, ctx) {
    await requireSuperAdmin(ctx);
    const stores = await ctx.q(
      'SELECT id, store_name FROM public.platform_stores WHERE user_id = $1 AND deleted_at IS NULL',
      [p_target_user_id],
    );

    const results = [];
    for (const s of stores) {
      const ordersCount = await ctx.one('SELECT count(*) AS n FROM public.orders WHERE store_id = $1', [s.id]);
      await ctx.q('UPDATE public.platform_stores SET deleted_at = now() WHERE id = $1', [s.id]);
      results.push({
        store_id: s.id,
        store_name: s.store_name,
        orders_count: Number(ordersCount?.n ?? 0),
        action: 'soft_deleted',
      });
    }

    await logAdminAction(ctx, 'admin_cascade_soft_delete_user_stores', {
      targetUserId: p_performed_by,
      details: { target_user_id: p_target_user_id, stores: results.map((r) => r.store_id) },
    });

    return results;
  },

  /** admin_cleanup_orphan_auth_user(p_target_user_id, p_performed_by) → { auth_deleted, partial_stores_cleaned, partial_memberships_cleaned }[] */
  async admin_cleanup_orphan_auth_user({ p_target_user_id, p_performed_by }, ctx) {
    await requireSuperAdmin(ctx);

    return ctx.tx(async (t) => {
      const stores = await t.q(
        'UPDATE public.platform_stores SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL RETURNING id',
        [p_target_user_id],
      );
      const memberships = await t.q(
        'UPDATE public.store_members SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL RETURNING id',
        [p_target_user_id],
      );

      let authDeleted = false;
      const authUser = await t.one('SELECT id FROM auth.users WHERE id = $1', [p_target_user_id]);
      if (authUser) {
        await t.q('UPDATE auth.users SET deleted_at = now() WHERE id = $1', [p_target_user_id]);
        authDeleted = true;
      }

      await t.q(
        `INSERT INTO public.admin_audit_logs (action, performed_by, target_user_id, details)
         VALUES ($1, $2, $3, $4)`,
        [
          'admin_cleanup_orphan_auth_user',
          ctx.userId,
          p_performed_by,
          { target_user_id: p_target_user_id, stores_cleaned: stores.length, memberships_cleaned: memberships.length },
        ],
      );

      return [
        {
          auth_deleted: authDeleted,
          partial_stores_cleaned: stores.length,
          partial_memberships_cleaned: memberships.length,
        },
      ];
    });
  },

  /** suggest_store_for_orphan_orders() → { store_id, store_name, matched_orders, match_score, match_basis }[] */
  async suggest_store_for_orphan_orders(_args, ctx) {
    await requireSuperAdmin(ctx);
    return ctx.q(
      `SELECT
         s.id AS store_id,
         s.store_name,
         count(o.id) AS matched_orders,
         count(o.id)::float AS match_score,
         'client_phone_match' AS match_basis
       FROM public.orders o
       JOIN public.clients c ON c.phone = o.client_phone AND c.phone <> ''
       JOIN public.platform_stores s ON s.id = c.store_id
       WHERE o.store_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.platform_stores ps WHERE ps.id = o.store_id AND ps.deleted_at IS NULL)
       GROUP BY s.id, s.store_name
       ORDER BY matched_orders DESC`,
    );
  },
};
