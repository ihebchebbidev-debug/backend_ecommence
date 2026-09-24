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
    const slugBase = slugify(storeName);

    return ctx.tx(async (t) => {
      const completed = await t.one(
        `SELECT s.id, s.store_name, s.slug
           FROM public.onboarding_progress op
           JOIN public.platform_stores s ON s.id = op.store_id
          WHERE op.user_id = $1 AND op.completed = true AND s.user_id = $1
          LIMIT 1`,
        [userId],
      );
      if (completed) {
        return [{
          success: true,
          created_store_id: completed.id,
          created_store_name: completed.store_name,
          created_store_slug: completed.slug,
        }];
      }

      let slug = slugBase;
      for (let i = 0; i < 5; i += 1) {
        const clash = await t.one('SELECT 1 FROM public.platform_stores WHERE slug = $1', [slug]);
        if (!clash) break;
        slug = `${slugBase}-${Math.random().toString(36).slice(2, 6)}`;
      }

      const selectedPlan = String(input.selected_plan || input.plan_code || 'starter').toLowerCase();
      const trialBalance = { starter: 5, pro: 20, business: 50, business_plus: 100 }[selectedPlan] || 5;
      const trialDays = ['pro', 'business'].includes(selectedPlan) ? 10 : 0;
      const subscriptionStatus = selectedPlan === 'business_plus' ? 'pending_contact' : trialDays > 0 ? 'trialing' : 'active';
      const themeId = String(input.theme_id || 'oslo');
      const primaryColor = String(input.primary_color || '#1E293B');
      const secondaryColor = String(input.secondary_color || '#64748B');
      const logoUrl = input.logo_url || null;
      const subscriptionPlan = await t.one(
        `SELECT id FROM public.subscription_plans WHERE lower(name) = $1 AND is_active = true LIMIT 1`,
        [selectedPlan],
      );

      const store = await t.one(
        `INSERT INTO public.platform_stores
           (store_name, slug, country, currency, user_id, subscription_plan, plan_id, status,
            default_language, enabled_languages, store_color, logo_url, settings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active','fr',ARRAY['ar','fr'],$8,$9,'{}'::jsonb)
         RETURNING id, store_name, slug`,
        [storeName, slug, input.country || 'TN', input.currency || 'TND', userId, selectedPlan, subscriptionPlan?.id || null, primaryColor, logoUrl],
      );

      await t.q(
        `INSERT INTO public.store_members (store_id,user_id,role,status,permissions,created_at,updated_at)
         VALUES ($1,$2,'owner','active',$3::jsonb,now(),now())`,
        [store.id, userId, JSON.stringify({ dashboard: true, orders: true, products: true, customers: true, settings: true, team: true })],
      );
      await t.q(
        `INSERT INTO public.store_delivery_settings
           (store_id,dispatch_mode,auto_send_after_confirmation,created_at,updated_at)
         VALUES ($1,'popup',false,now(),now())`,
        [store.id],
      );
      await t.q(
        `INSERT INTO public.store_theme
           (store_id,theme_id,primary_color,secondary_color,logo_url,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [store.id, themeId, primaryColor, secondaryColor, logoUrl],
      );
      await t.q(
        `INSERT INTO public.checkout_settings
           (store_id,checkout_type,position,require_phone,require_address,require_email,require_notes,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [store.id, input.checkout_type || 'multi_step', input.checkout_position || 'right', input.require_phone ?? true, input.require_address ?? true, input.require_email ?? false, input.require_notes ?? false],
      );

      const answers = input.answers || {};
      await t.q(
        `INSERT INTO public.store_onboarding_answers
           (store_id,sector,products_range,monthly_orders_range,team_size,main_objective,ecommerce_experience,
            has_confirmation_team,needs_online_payment,needs_whatsapp_or_sms_otp,needs_marketing_support,
            recommended_plan,selected_plan,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
        [store.id, answers.activity || null, answers.catalog_size || null, answers.monthly_orders || null,
          answers.team_size || null, answers.main_goal || null, answers.experience || null,
          input.hasConfirmationTeam ?? input.has_confirmation_team ?? null,
          input.needsOnlinePayment ?? input.needs_online_payment ?? null,
          input.needsWhatsappOrSmsOtp ?? input.needs_whatsapp_or_sms_otp ?? null,
          input.needsMarketingSupport ?? input.needs_marketing_support ?? null,
          input.recommended_plan || null, selectedPlan],
      );
      await t.q(
        `INSERT INTO public.store_subscriptions
           (store_id,user_id,plan_id,status,billing_cycle,started_at,trial_ends_at,current_period_end,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'monthly',now(),
                 CASE WHEN $5 > 0 THEN now() + ($5 || ' days')::interval ELSE NULL END,
                 CASE WHEN $5 > 0 THEN (now() + ($5 || ' days')::interval)::text ELSE NULL END,
                 now(),now())`,
        [store.id, userId, subscriptionPlan?.id || null, subscriptionStatus, trialDays],
      );
      const wallet = await t.one(
        `INSERT INTO public.store_wallets
           (store_id,balance_usd,trial_balance_usd,trial_balance_expires_at,display_currency,
            payment_currency,balance_tnd,currency_tnd,starter_order_fee_tnd,created_at,updated_at)
         VALUES ($1,0,$2,CASE WHEN $3 > 0 THEN now() + ($3 || ' days')::interval ELSE NULL END,
                 'USD','TND',0,'TND',0.350,now(),now()) RETURNING id`,
        [store.id, trialBalance, trialDays],
      );
      await t.q(
        `INSERT INTO public.wallet_transactions
           (store_id,wallet_id,user_id,type,amount,amount_usd,status,description,metadata,created_at)
         VALUES ($1,$2,$3,'trial_credit',$4,$4,'completed','Crédit d''essai offert',$5::jsonb,now())`,
        [store.id, wallet.id, userId, trialBalance, JSON.stringify({ selected_plan: selectedPlan, source: 'onboarding_trial_credit', currency: 'TND' })],
      );
      await t.q(
        `INSERT INTO public.onboarding_progress (user_id,current_step,completed,store_id,updated_at)
         VALUES ($1,'done',true,$2,now())
         ON CONFLICT (user_id) DO UPDATE SET current_step='done',completed=true,store_id=EXCLUDED.store_id,updated_at=now()`,
        [userId, store.id],
      );

      return [{
        success: true,
        created_store_id: store.id,
        created_store_name: store.store_name,
        created_store_slug: store.slug,
      }];
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
