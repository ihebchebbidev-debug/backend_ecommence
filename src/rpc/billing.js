// Plans & Billing — spec 3.10
import { forbidden, badRequest } from '../lib/errors.js';

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
  /** plan_allows(p_store_id, p_feature_key) → boolean */
  async plan_allows({ p_store_id, p_feature_key }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
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

  /** get_active_exchange_rate(p_base?, p_target?) → number */
  async get_active_exchange_rate({ p_base, p_target } = {}, ctx) {
    const base = p_base || 'USD';
    const target = p_target || 'TND';
    const row = await ctx.one(
      `SELECT rate FROM public.currency_rates
        WHERE is_active = true AND base_currency = $1 AND target_currency = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [base, target],
    );
    return row ? Number(row.rate) : null;
  },
};
