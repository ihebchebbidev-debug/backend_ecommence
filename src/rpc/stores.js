// Store Management — spec 3.2
import { forbidden, badRequest } from '../lib/errors.js';

function slugify(name) {
  return String(name || 'store')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'store';
}

export default {
  /** get_accessible_stores() → stores the caller owns or is a member of. */
  async get_accessible_stores(_args, ctx) {
    ctx.requireAuth();
    if (ctx.isServiceRole) {
      return ctx.q(
        `SELECT id, store_name, slug, status, currency, country, logo_url,
                store_color, settings, subscription_plan, user_id, created_at,
                true AS is_owner
         FROM public.platform_stores WHERE deleted_at IS NULL ORDER BY created_at DESC`,
      );
    }
    return ctx.q(
      `SELECT DISTINCT ON (s.id)
              s.id, s.store_name, s.slug, s.status, s.currency, s.country, s.logo_url,
              s.store_color, s.settings, s.subscription_plan, s.user_id, s.created_at,
              (s.user_id = $1) AS is_owner
         FROM public.platform_stores s
         LEFT JOIN public.store_members m ON m.store_id = s.id AND m.user_id = $1
        WHERE s.deleted_at IS NULL AND (s.user_id = $1 OR m.user_id = $1)
        ORDER BY s.id, s.created_at DESC`,
      [ctx.userId],
    );
  },

  /** create_initial_store_for_user(p_input) → creates the first store for a new user. */
  async create_initial_store_for_user({ p_input }, ctx) {
    const userId = ctx.requireAuth() ?? ctx.userId;
    if (!userId) throw badRequest('p_input requires an authenticated user');
    const input = p_input || {};
    const storeName = input.store_name || 'My Store';
    const slugBase = slugify(input.store_name);

    return ctx.tx(async (t) => {
      let slug = slugBase;
      for (let i = 0; i < 5; i += 1) {
        const clash = await t.one('SELECT 1 FROM public.platform_stores WHERE slug = $1', [slug]);
        if (!clash) break;
        slug = `${slugBase}-${Math.random().toString(36).slice(2, 6)}`;
      }

      const store = await t.one(
        `INSERT INTO public.platform_stores (store_name, slug, country, currency, user_id, subscription_plan, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         RETURNING id, store_name, slug`,
        [storeName, slug, input.country || 'TN', input.currency || 'TND', userId, input.plan_code || 'starter'],
      );

      if (input.sector || input.ecommerce_experience || input.monthly_orders_range || input.team_size) {
        await t.q(
          `INSERT INTO public.store_onboarding_answers
             (store_id, sector, ecommerce_experience, monthly_orders_range, team_size,
              products_range, main_objective, has_confirmation_team, needs_online_payment,
              needs_whatsapp_or_sms_otp, needs_marketing_support, recommended_plan, selected_plan)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            store.id,
            input.sector ?? null,
            input.ecommerce_experience ?? null,
            input.monthly_orders_range ?? null,
            input.team_size ?? null,
            input.products_range ?? null,
            input.main_objective ?? null,
            input.has_confirmation_team ?? null,
            input.needs_online_payment ?? null,
            input.needs_whatsapp_or_sms_otp ?? null,
            input.needs_marketing_support ?? null,
            input.recommended_plan ?? null,
            input.plan_code ?? null,
          ],
        );
      }

      return [
        {
          success: true,
          created_store_id: store.id,
          created_store_name: store.store_name,
          created_store_slug: store.slug,
        },
      ];
    });
  },

  /** get_store_role(p_store_id, p_user_id) → 'owner' | 'admin' | ... | null */
  async get_store_role({ p_store_id, p_user_id }, ctx) {
    ctx.requireAuth();
    if (!ctx.isServiceRole && p_user_id !== ctx.userId) {
      const canSee = (await ctx.storeRole(p_store_id)) === 'owner' || (await ctx.isAnyAdmin());
      if (!canSee) throw forbidden('Access denied to this store');
    }
    if (p_user_id === ctx.userId) return ctx.storeRole(p_store_id);
    const owner = await ctx.one('SELECT 1 FROM public.platform_stores WHERE id = $1 AND user_id = $2', [
      p_store_id,
      p_user_id,
    ]);
    if (owner) return 'owner';
    const m = await ctx.one('SELECT role FROM public.store_members WHERE store_id = $1 AND user_id = $2 LIMIT 1', [
      p_store_id,
      p_user_id,
    ]);
    return m?.role ?? null;
  },

  /** has_store_permission(p_store_id, p_permission) → boolean */
  async has_store_permission({ p_store_id, p_permission }, ctx) {
    ctx.requireAuth();
    return ctx.hasStorePermission(p_store_id, p_permission);
  },

  /** user_store_ids() → string[] */
  async user_store_ids(_args, ctx) {
    ctx.requireAuth();
    return ctx.userStoreIds();
  },
};
