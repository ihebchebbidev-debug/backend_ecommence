// Plans & Billing — spec 3.10
import { forbidden, badRequest } from '../lib/errors.js';

const PLAN_CODES = ['essentiel', 'expansion', 'performance', 'prestige'];
async function requireSuperAdmin(ctx) {
  ctx.requireAuth();
  if (!(await ctx.isSuperAdmin())) throw forbidden('Super admin access required');
}

// Plans are billing-only (Essentiel/Expansion/Performance/Prestige): features and counts are never gated by plan.
export const ALL_PLANS_UNLOCKED = true;

const BOOLEAN_LIMIT_KEYS = new Set([
  'can_advanced_analytics', 'can_api_access', 'can_custom_domain', 'can_export_data',
  'can_multi_currency', 'has_ab_testing', 'has_advanced_crm', 'has_advanced_roles',
  'has_advanced_seo', 'has_advanced_stock', 'has_affiliate', 'has_api',
  'has_auto_cart_recovery', 'has_automation', 'has_basic_crm', 'has_bundles', 'has_cod',
  'has_confirmation_agents', 'has_coupons', 'has_custom_dev', 'has_custom_domain',
  'has_delivery_integration', 'has_landing_pages', 'has_languages', 'has_marketing_service',
  'has_multi_depot', 'has_multi_warehouse', 'has_online_payment', 'has_order_confirmation',
  'has_pixels', 'has_premium_templates', 'has_priority_support', 'has_reviews',
  'has_sales_pages', 'has_sla', 'has_team_ranking', 'has_trust_score', 'has_twilio',
  'has_upsell', 'has_upsell_crosssell', 'has_webhooks',
]);

const NUMERIC_LIMIT_KEYS = new Set([
  'max_coupons', 'max_orders_per_month', 'max_products', 'max_stores',
  'max_team_members', 'max_warehouses', 'per_order_fee', 'trial_balance_usd', 'trial_days',
]);

async function getPlanLimits(ctx, storeId) {
  return ctx.one(
    `SELECT pl.*
       FROM public.platform_stores s
       JOIN public.plan_limits pl ON pl.plan_id = s.plan_id OR pl.plan = s.subscription_plan
      WHERE s.id = $1
      ORDER BY (pl.plan_id = s.plan_id) DESC
      LIMIT 1`,
    [storeId],
  );
}

export default {
  /** plan_overview(p_store_id) → billing dashboard numbers (quota, usage, commissions, history). */
  async plan_overview({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const row = await ctx.one('SELECT public.plan_overview($1) AS v', [p_store_id]);
    return row?.v ?? null;
  },

  /** plan_switch(p_store_id, p_plan_code, p_billing_cycle) — one-click change until payment APIs exist. */
  async plan_switch({ p_store_id, p_plan_code, p_billing_cycle }, ctx) {
    await ctx.assertStoreAccess(p_store_id, ['owner', 'admin']);
    const code = String(p_plan_code || '');
    const cycle = String(p_billing_cycle || 'monthly');
    if (!['essentiel', 'expansion', 'performance', 'prestige'].includes(code)) throw badRequest('Invalid plan');
    if (!['monthly', 'annual'].includes(cycle)) throw badRequest('Invalid billing cycle');
    return ctx.tx(async (t) => {
      await t.one('SELECT public.plan_switch($1, $2, $3)', [p_store_id, code, cycle]);
      const row = await t.one('SELECT public.plan_overview($1) AS v', [p_store_id]);
      if (!row?.v) throw badRequest('Plan overview unavailable');
      return row.v;
    });
  },
  /** plan_allows(p_store_id, p_feature_key) → boolean */
  async plan_allows({ p_store_id, p_feature_key }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    if (ALL_PLANS_UNLOCKED) return true;
    const override = await ctx.one(
      `SELECT is_enabled FROM public.store_feature_overrides WHERE store_id = $1 AND feature_key = $2`,
      [p_store_id, p_feature_key],
    );
    if (override) return !!override.is_enabled;
    if (!BOOLEAN_LIMIT_KEYS.has(p_feature_key)) return false;
    const limits = await getPlanLimits(ctx, p_store_id);
    return !!limits?.[p_feature_key];
  },

  /** plan_limit(p_store_id, p_limit_key) → number */
  async plan_limit({ p_store_id, p_limit_key }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    if (ALL_PLANS_UNLOCKED) {
      if (p_limit_key === 'per_order_fee') return 0;
      if (String(p_limit_key).startsWith('max_')) return 1000000000;
    }
    const custom = await ctx.one(
      `SELECT * FROM public.store_custom_limits WHERE store_id = $1`,
      [p_store_id],
    );
    if (custom && Object.prototype.hasOwnProperty.call(custom, p_limit_key) && custom[p_limit_key] != null) {
      return Number(custom[p_limit_key]);
    }
    if (!NUMERIC_LIMIT_KEYS.has(p_limit_key)) return null;
    const limits = await getPlanLimits(ctx, p_store_id);
    const value = limits?.[p_limit_key];
    return value == null ? null : Number(value);
  },

  /** charge_starter_order_fee(p_store_id, p_order_id) → boolean */
  async charge_starter_order_fee({ p_store_id, p_order_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id, ['owner', 'admin']);
    return ctx.tx(async (t) => {
      const order = await t.one(
        `SELECT id, order_fee_amount_usd, order_billing_status FROM public.orders
          WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [p_order_id, p_store_id],
      );
      if (!order) throw badRequest('Order not found for this store');
      if (order.order_billing_status === 'charged') return true;

      const fee = Number(order.order_fee_amount_usd || 0);
      if (fee <= 0) {
        await t.q(
          `UPDATE public.orders SET order_billing_status = 'charged', order_fee_charged_at = now() WHERE id = $1`,
          [p_order_id],
        );
        return true;
      }

      const wallet = await t.one(
        `SELECT id, balance_usd FROM public.store_wallets WHERE store_id = $1 FOR UPDATE`,
        [p_store_id],
      );
      if (!wallet || Number(wallet.balance_usd) < fee) return false;

      await t.q('UPDATE public.store_wallets SET balance_usd = balance_usd - $1, updated_at = now() WHERE id = $2', [
        fee,
        wallet.id,
      ]);
      await t.q(
        `UPDATE public.orders SET order_billing_status = 'charged', order_fee_charged_at = now() WHERE id = $1`,
        [p_order_id],
      );
      return true;
    });
  },

  /** credit_wallet(p_user_id, p_amount, p_description, p_reference) → void */
  async credit_wallet({ p_user_id, p_amount, p_description, p_reference }, ctx) {
    if (!ctx.isServiceRole && ctx.userId !== p_user_id) throw forbidden('Cannot credit another user wallet');
    const amount = Number(p_amount);
    if (!(amount > 0)) throw badRequest('p_amount must be positive');
    await ctx.tx(async (t) => {
      let wallet = await t.one('SELECT id FROM public.wallets WHERE user_id = $1 FOR UPDATE', [p_user_id]);
      if (!wallet) {
        wallet = await t.one('INSERT INTO public.wallets (user_id, balance) VALUES ($1, 0) RETURNING id', [
          p_user_id,
        ]);
      }
      await t.q('UPDATE public.wallets SET balance = balance + $1, updated_at = now() WHERE id = $2', [
        amount,
        wallet.id,
      ]);
      await t.q(
        `INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, status)
         VALUES ($1, $2, 'credit', $3, $4, $5, 'completed')`,
        [wallet.id, p_user_id, amount, p_description ?? null, p_reference ?? null],
      );
    });
    return null;
  },

  /** debit_wallet(p_user_id, p_amount, p_description) → boolean */
  async debit_wallet({ p_user_id, p_amount, p_description }, ctx) {
    if (!ctx.isServiceRole && ctx.userId !== p_user_id) throw forbidden('Cannot debit another user wallet');
    const amount = Number(p_amount);
    if (!(amount > 0)) throw badRequest('p_amount must be positive');
    return ctx.tx(async (t) => {
      const wallet = await t.one('SELECT id, balance FROM public.wallets WHERE user_id = $1 FOR UPDATE', [
        p_user_id,
      ]);
      if (!wallet || Number(wallet.balance) < amount) return false;
      await t.q('UPDATE public.wallets SET balance = balance - $1, updated_at = now() WHERE id = $2', [
        amount,
        wallet.id,
      ]);
      await t.q(
        `INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, status)
         VALUES ($1, $2, 'debit', $3, $4, 'completed')`,
        [wallet.id, p_user_id, amount, p_description ?? null],
      );
      return true;
    });
  },

  /** get_active_exchange_rate(p_base?, p_target?) → number (admin manual rate wins over the daily automatic rate). */
  async get_active_exchange_rate({ p_base, p_target } = {}, ctx) {
    const base = String(p_base || 'USD').toUpperCase();
    const target = String(p_target || 'TND').toUpperCase();
    const row = await ctx.one(
      `SELECT rate FROM public.currency_rates
        WHERE is_active = true AND base_currency = $1 AND target_currency = $2 AND rate > 0
        ORDER BY (source = 'manual') DESC, updated_at DESC LIMIT 1`,
      [base, target],
    );
    return row ? Number(row.rate) : null;
  },

  // ── Platform admin: shop plans, commissions and the exchange rate ──────────
  /** admin_plan_shops(p_search?) → every shop with its plan, usage and unpaid commissions. */
  async admin_plan_shops({ p_search } = {}, ctx) {
    await requireSuperAdmin(ctx);
    const search = String(p_search || '').trim();
    const shops = await ctx.q(
      `SELECT s.id, s.store_name AS name, p.email FROM public.platform_stores s LEFT JOIN public.profiles p ON p.id = s.user_id
        WHERE ($1 = '' OR s.store_name ILIKE '%' || $1 || '%' OR p.email ILIKE '%' || $1 || '%')
        ORDER BY s.created_at DESC NULLS LAST LIMIT 100`, [search]);
    const out = [];
    for (const s of shops) {
      const ov = await ctx.tx((t) => t.one('SELECT public.plan_overview($1) AS v', [s.id]));
      out.push({ store_id: s.id, name: s.name, email: s.email, overview: ov?.v ?? null });
    }
    return out;
  },

  /** admin_plan_set(p_store_id, p_plan_code, p_billing_cycle) — applies immediately, including downgrades. */
  async admin_plan_set({ p_store_id, p_plan_code, p_billing_cycle }, ctx) {
    await requireSuperAdmin(ctx);
    const code = String(p_plan_code || '');
    const cycle = code === 'essentiel' ? 'monthly' : String(p_billing_cycle || 'monthly');
    if (!PLAN_CODES.includes(code)) throw badRequest('Invalid plan');
    if (!['monthly', 'annual'].includes(cycle)) throw badRequest('Invalid billing cycle');
    await ctx.tx(async (t) => {
      await t.one('SELECT public.plan_refresh($1)', [p_store_id]);
      // Clear any paid period so plan_switch applies a downgrade now instead of scheduling it.
      await t.q('UPDATE public.store_plan_state SET period_end = NULL, pending_plan_code = NULL WHERE store_id = $1', [p_store_id]);
      await t.one('SELECT public.plan_switch($1, $2, $3)', [p_store_id, code, cycle]);
      await t.q(`INSERT INTO public.store_plan_events (store_id, kind, details) VALUES ($1, 'admin_plan_set', $2)`,
        [p_store_id, { to: code, cycle, by: ctx.userId }]);
      await t.q(`INSERT INTO public.admin_audit_logs (action, performed_by, target_store_id, details) VALUES ('PLAN_SET', $1, $2, $3)`,
        [ctx.userId, p_store_id, { plan: code, cycle }]);
    });
    const row = await ctx.one('SELECT public.plan_overview($1) AS v', [p_store_id]);
    return row?.v ?? null;
  },

  /** admin_commission_adjust(p_store_id, p_action, p_reason) — mark every unpaid commission 'paid' or 'cancelled' (waived). */
  async admin_commission_adjust({ p_store_id, p_action, p_reason }, ctx) {
    await requireSuperAdmin(ctx);
    const action = String(p_action || '');
    if (!['paid', 'cancelled'].includes(action)) throw badRequest('Invalid action');
    const reason = String(p_reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('A reason is required');
    const res = await ctx.tx(async (t) => {
      const rows = await t.q(`UPDATE public.store_plan_usage SET commission_status = $2, resolved_at = now()
        WHERE store_id = $1 AND commission_status = 'unpaid' RETURNING commission_usd`, [p_store_id, action]);
      const total = rows.reduce((a, r) => a + Number(r.commission_usd || 0), 0);
      await t.q(`INSERT INTO public.store_plan_events (store_id, kind, details) VALUES ($1, $2, $3)`,
        [p_store_id, action === 'paid' ? 'commission_paid' : 'commission_waived', { orders: rows.length, amount_usd: total, reason }]);
      await t.q(`INSERT INTO public.admin_audit_logs (action, performed_by, target_store_id, details) VALUES ($1, $2, $3, $4)`,
        [action === 'paid' ? 'COMMISSION_PAID' : 'COMMISSION_WAIVED', ctx.userId, p_store_id, { orders: rows.length, amount_usd: total, reason }]);
      return { orders: rows.length, amount_usd: total };
    });
    return res;
  },

  /** admin_exchange_rate_set(p_rate) — manual USD→TND rate; null/0 removes it so the daily rate applies. */
  async admin_exchange_rate_set({ p_rate }, ctx) {
    await requireSuperAdmin(ctx);
    const rate = p_rate == null || p_rate === '' ? 0 : Number(p_rate);
    if (rate !== 0 && !(rate >= 2 && rate <= 5)) throw badRequest('Rate must be between 2 and 5 TND per USD');
    await ctx.tx(async (t) => {
      await t.q(`UPDATE public.currency_rates SET is_active = false, updated_at = now() WHERE base_currency='USD' AND target_currency='TND' AND source='manual'`);
      if (rate) await t.q(`INSERT INTO public.currency_rates (base_currency, target_currency, rate, is_active, source) VALUES ('USD','TND',$1,true,'manual')`, [rate]);
      await t.q(`INSERT INTO public.admin_audit_logs (action, performed_by, details) VALUES ('EXCHANGE_RATE_SET', $1, $2)`, [ctx.userId, { rate: rate || null }]);
    });
    return rateInfo(ctx);
  },

  /** admin_exchange_rate_info() → current manual and automatic USD→TND rates. */
  async admin_exchange_rate_info(_args, ctx) {
    await requireSuperAdmin(ctx);
    return rateInfo(ctx);
  },
};

async function rateInfo(ctx) {
  {
    const rows = await ctx.q(`SELECT DISTINCT ON (source) source, rate, updated_at FROM public.currency_rates
      WHERE base_currency='USD' AND target_currency='TND' AND is_active AND source IN ('manual','auto') ORDER BY source, updated_at DESC`);
    const by = Object.fromEntries(rows.map((r) => [r.source, { rate: Number(r.rate), updated_at: r.updated_at }]));
    return { manual: by.manual ?? null, auto: by.auto ?? null, effective: (by.manual ?? by.auto)?.rate ?? 3.1 };
  }
};
