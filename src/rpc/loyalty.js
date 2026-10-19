// Private shop loyalty operations; reward issuance shares coupon permissions and limits.
import crypto from 'node:crypto';
import { badRequest, forbidden } from '../lib/errors.js';
import { permission } from '../lib/commerce.js';
import { phoneKey, tierFor } from '../lib/loyalty.js';
import billing from './billing.js';
const PERM = 'canManageCoupons';
const num = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} invalide`);
  return n;
};

const DEFAULT_LOYALTY = { enabled: false, points_per_unit: 1, reward_points: 100, reward_type: 'fixed', reward_value: 10, silver_points: 500, gold_points: 1500 };

async function loyaltySettings(db, storeId) {
  return (await db.one('SELECT * FROM public.store_loyalty_settings WHERE store_id=$1', [storeId])) || { ...DEFAULT_LOYALTY, store_id: storeId };
}

const integer = (v, min, max, label) => { const n = num(v, min, max, label); if (!Number.isInteger(n)) throw badRequest(`${label} invalide`); return n; };
export default {
  // ── Loyalty ────────────────────────────────────────────────────────────
  async loyalty_overview({ p_store_id, p_search = '' }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const s = await loyaltySettings(ctx, p_store_id);
    const term = `%${String(p_search || '').trim().slice(0, 60)}%`;
    const accounts = await ctx.q(`SELECT phone, name, points, lifetime_points, updated_at FROM public.store_loyalty_accounts
      WHERE store_id=$1 AND (phone ILIKE $2 OR name ILIKE $2) ORDER BY lifetime_points DESC LIMIT 200`, [p_store_id, term]);
    const totals = await ctx.one(`SELECT count(*)::int AS members, coalesce(sum(points),0)::int AS open_points FROM public.store_loyalty_accounts WHERE store_id=$1`, [p_store_id]);
    const redeemed = await ctx.one(`SELECT count(*)::int AS n FROM public.store_loyalty_ledger WHERE store_id=$1 AND reason='redeemed'`, [p_store_id]);
    return { settings: s, accounts: accounts.map((a) => ({ ...a, tier: tierFor(a.lifetime_points, s) })), members: totals?.members ?? 0, open_points: totals?.open_points ?? 0, rewards_issued: redeemed?.n ?? 0 };
  },

  async loyalty_settings_save({ p_store_id, p_settings }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const v = p_settings || {};
    if (typeof v.enabled !== 'boolean' || !['fixed', 'percentage'].includes(v.reward_type)) throw badRequest('Réglages invalides');
    const d = {
      enabled: v.enabled === true,
      points_per_unit: num(v.points_per_unit, 0, 100, 'Points par unité'),
      reward_points: integer(v.reward_points, 1, 1000000, 'Points requis'),
      reward_type: v.reward_type === 'percentage' ? 'percentage' : 'fixed',
      reward_value: num(v.reward_value, 0.01, 1000000, 'Valeur de la récompense'),
      silver_points: integer(v.silver_points, 1, 10000000, 'Seuil Argent'),
      gold_points: integer(v.gold_points, 1, 10000000, 'Seuil Or'),
    };
    if (d.reward_type === 'percentage' && d.reward_value > 100) throw badRequest('Un pourcentage ne peut pas dépasser 100');
    if (d.gold_points <= d.silver_points) throw badRequest('Le seuil Or doit être supérieur au seuil Argent');
    return ctx.one(`INSERT INTO public.store_loyalty_settings AS s(store_id, enabled, enabled_at, points_per_unit, reward_points, reward_type, reward_value, silver_points, gold_points)
      VALUES ($1,$2, CASE WHEN $2 THEN now() END, $3,$4,$5,$6,$7,$8)
      ON CONFLICT (store_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        enabled_at = CASE WHEN EXCLUDED.enabled AND s.enabled_at IS NULL THEN now() ELSE s.enabled_at END,
        points_per_unit=EXCLUDED.points_per_unit, reward_points=EXCLUDED.reward_points, reward_type=EXCLUDED.reward_type,
        reward_value=EXCLUDED.reward_value, silver_points=EXCLUDED.silver_points, gold_points=EXCLUDED.gold_points, updated_at=now()
      RETURNING *`, [p_store_id, d.enabled, d.points_per_unit, d.reward_points, d.reward_type, d.reward_value, d.silver_points, d.gold_points]);
  },

  /** Seller adds or removes points by hand (gesture, correction). */
  async loyalty_adjust({ p_store_id, p_phone, p_name = '', p_points }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const phone = phoneKey(p_phone);
    if (!phone) throw badRequest('Numéro invalide');
    const pts = num(p_points, -1000000, 1000000, 'Points');
    if (!Number.isInteger(pts)) throw badRequest('Points entiers requis');
    if (!pts) throw badRequest('Points invalides');
    return ctx.tx(async (t) => {
      const acc = await t.one(`INSERT INTO public.store_loyalty_accounts AS a(store_id, phone, name) VALUES ($1,$2,$3)
        ON CONFLICT (store_id, phone) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE a.name END RETURNING *`,
        [p_store_id, phone, String(p_name || '').trim().slice(0, 120)]);
      if (Number(acc.points) + pts < 0) throw badRequest('Solde de points insuffisant');
      await t.q('INSERT INTO public.store_loyalty_ledger(store_id, phone, points, reason) VALUES ($1,$2,$3,$4)', [p_store_id, phone, pts, 'manual']);
      return t.one(`UPDATE public.store_loyalty_accounts SET points=points+$3, lifetime_points=lifetime_points+GREATEST($3,0), updated_at=now()
        WHERE store_id=$1 AND phone=$2 RETURNING *`, [p_store_id, phone, pts]);
    });
  },

  /** Converts points into a single-use coupon code the customer can use at checkout. */
  async loyalty_redeem({ p_store_id, p_phone }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const phone = phoneKey(p_phone);
    if (!phone) throw badRequest('Numéro invalide');
    return ctx.tx(async (t) => {
      await t.one('SELECT id FROM public.platform_stores WHERE id=$1 FOR UPDATE', [p_store_id]);
      const s = await loyaltySettings(t, p_store_id);
      if (!s.enabled) throw badRequest('Programme désactivé');
      const txCtx = { ...ctx, q: t.q, one: t.one };
      if (!(await billing.plan_allows({ p_store_id, p_feature_key: 'has_coupons' }, txCtx))) throw forbidden('Plan does not allow coupons');
      const max = await billing.plan_limit({ p_store_id, p_limit_key: 'max_coupons' }, txCtx);
      const count = await t.one('SELECT count(*)::int AS n FROM public.coupons WHERE store_id=$1', [p_store_id]);
      if (max == null || (max > 0 && count.n >= max)) throw forbidden('Coupon limit reached');
      const acc = await t.one('SELECT * FROM public.store_loyalty_accounts WHERE store_id=$1 AND phone=$2 FOR UPDATE', [p_store_id, phone]);
      if (!acc) throw badRequest('Client introuvable dans le programme');
      if (acc.points < s.reward_points) throw badRequest(`Il faut ${s.reward_points} points pour une récompense`);
      const code = `FID-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
      await t.q(`INSERT INTO public.coupons(store_id, code, type, value, active, max_uses, used_count, expires_at)
        VALUES ($1,$2,$3,$4,true,1,0, now() + interval '90 days')`, [p_store_id, code, s.reward_type, s.reward_value]);
      await t.q('INSERT INTO public.store_loyalty_ledger(store_id, phone, points, reason, coupon_code) VALUES ($1,$2,$3,$4,$5)', [p_store_id, phone, -s.reward_points, 'redeemed', code]);
      const updated = await t.one('UPDATE public.store_loyalty_accounts SET points=points-$3, updated_at=now() WHERE store_id=$1 AND phone=$2 RETURNING points', [p_store_id, phone, s.reward_points]);
      return { code, type: s.reward_type, value: Number(s.reward_value), points_left: updated.points };
    });
  },

  async loyalty_history({ p_store_id, p_phone }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const phone = phoneKey(p_phone);
    if (!phone) throw badRequest('Numéro invalide');
    return ctx.q(`SELECT l.points, l.reason, l.coupon_code, l.created_at, o.order_number FROM public.store_loyalty_ledger l
      LEFT JOIN public.orders o ON o.id = l.order_id WHERE l.store_id=$1 AND l.phone=$2 ORDER BY l.created_at DESC LIMIT 100`, [p_store_id, phone]);
  },

};
