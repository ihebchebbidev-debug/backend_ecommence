// Loyalty programme and seller email marketing RPCs (permission-checked per shop).
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { badRequest, forbidden } from '../lib/errors.js';
import { id, permission } from '../lib/commerce.js';
import { sendSmtp } from '../lib/messaging.js';
import { sanitizeBlocks, renderEmail, renderText } from '../lib/emailBlocks.js';
import { EMAIL_RE, SMTP_PORTS, phoneKey, tierFor, validSmtpHost, smtpOf, sellerSmtpReady } from '../lib/marketing.js';

const PERM = 'canManageAutomations';
const MAX_CAMPAIGNS = 200;
const num = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} invalide`);
  return n;
};

const DEFAULT_LOYALTY = { enabled: false, points_per_unit: 1, reward_points: 100, reward_type: 'fixed', reward_value: 10, silver_points: 500, gold_points: 1500 };

async function loyaltySettings(db, storeId) {
  return (await db.one('SELECT * FROM public.store_loyalty_settings WHERE store_id=$1', [storeId])) || { ...DEFAULT_LOYALTY, store_id: storeId };
}

function campaign(v) {
  if (!v || typeof v !== 'object') throw badRequest('Campagne invalide');
  const name = String(v.name || '').trim().slice(0, 120);
  if (!name) throw badRequest('Nom requis');
  return { name, subject: String(v.subject || '').trim().slice(0, 200), preheader: String(v.preheader || '').trim().slice(0, 200),
    accent: /^#[0-9a-f]{6}$/i.test(String(v.accent || '')) ? v.accent : '#15803d', blocks: sanitizeBlocks(v.blocks) };
}

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
    const d = {
      enabled: v.enabled === true,
      points_per_unit: num(v.points_per_unit, 0, 100, 'Points par unité'),
      reward_points: Math.round(num(v.reward_points, 1, 1000000, 'Points requis')),
      reward_type: v.reward_type === 'percentage' ? 'percentage' : 'fixed',
      reward_value: num(v.reward_value, 0.01, 1000000, 'Valeur de la récompense'),
      silver_points: Math.round(num(v.silver_points, 1, 10000000, 'Seuil Argent')),
      gold_points: Math.round(num(v.gold_points, 1, 10000000, 'Seuil Or')),
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
    const pts = Math.round(num(p_points, -1000000, 1000000, 'Points'));
    if (!pts) throw badRequest('Points invalides');
    return ctx.tx(async (t) => {
      const acc = await t.one(`INSERT INTO public.store_loyalty_accounts AS a(store_id, phone, name) VALUES ($1,$2,$3)
        ON CONFLICT (store_id, phone) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE a.name END RETURNING *`,
        [p_store_id, phone, String(p_name || '').trim().slice(0, 120)]);
      if (acc.points + pts < 0) throw badRequest('Solde de points insuffisant');
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
      const s = await loyaltySettings(t, p_store_id);
      const acc = await t.one('SELECT * FROM public.store_loyalty_accounts WHERE store_id=$1 AND phone=$2 FOR UPDATE', [p_store_id, phone]);
      if (!acc) throw badRequest('Client introuvable dans le programme');
      if (acc.points < s.reward_points) throw badRequest(`Il faut ${s.reward_points} points pour une récompense`);
      const code = `FID-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
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

  // ── Email marketing ────────────────────────────────────────────────────
  async email_marketing_overview({ p_store_id }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const s = await ctx.one('SELECT smtp_host, smtp_port, smtp_secure, smtp_user, from_email, from_name, verified_at, (smtp_pass <> \'\') AS has_password FROM public.store_email_settings WHERE store_id=$1', [p_store_id]);
    const campaigns = await ctx.q('SELECT id, name, subject, preheader, accent, blocks, status, total, sent_count, failed_count, last_error, sent_at, created_at, updated_at FROM public.store_email_campaigns WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100', [p_store_id]);
    const aud = await ctx.one(`SELECT count(DISTINCT lower(trim(c.email)))::int AS n FROM public.clients c
      WHERE c.store_id=$1 AND c.email ~* '^[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+$'
        AND NOT EXISTS (SELECT 1 FROM public.store_email_unsubscribes u WHERE u.store_id=c.store_id AND u.email=lower(trim(c.email)))`, [p_store_id]);
    const shop = await ctx.one('SELECT store_name, slug, store_domain FROM public.platform_stores WHERE id=$1', [p_store_id]);
    return { settings: s || null, ready: !!(s && s.has_password && s.smtp_host), campaigns, audience: aud?.n ?? 0, shop };
  },

  async email_settings_save({ p_store_id, p_settings }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const v = p_settings || {};
    const host = String(v.smtp_host || '').trim().toLowerCase();
    const port = Number(v.smtp_port);
    const user = String(v.smtp_user || '').trim().slice(0, 200);
    const from = String(v.from_email || user).trim().slice(0, 200);
    if (!validSmtpHost(host)) throw badRequest('Serveur SMTP invalide');
    if (!SMTP_PORTS.includes(port)) throw badRequest('Port SMTP invalide (25, 465, 587 ou 2525)');
    if (!user) throw badRequest('Identifiant SMTP requis');
    if (!EMAIL_RE.test(from)) throw badRequest("Adresse d'expédition invalide");
    const pass = typeof v.smtp_pass === 'string' && v.smtp_pass ? v.smtp_pass.slice(0, 500) : null;
    const existing = await ctx.one('SELECT smtp_pass FROM public.store_email_settings WHERE store_id=$1', [p_store_id]);
    if (!pass && !existing?.smtp_pass) throw badRequest('Mot de passe SMTP requis');
    await ctx.q(`INSERT INTO public.store_email_settings AS s(store_id, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_email, from_name, verified_at)
      VALUES ($1,$2,$3,$4,$5,coalesce($6,''),$7,$8,NULL)
      ON CONFLICT (store_id) DO UPDATE SET smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port, smtp_secure=EXCLUDED.smtp_secure,
        smtp_user=EXCLUDED.smtp_user, smtp_pass=coalesce($6, s.smtp_pass), from_email=EXCLUDED.from_email, from_name=EXCLUDED.from_name,
        verified_at=NULL, updated_at=now()`,
      [p_store_id, host, port, v.smtp_secure === true || port === 465, user, pass, from, String(v.from_name || '').trim().slice(0, 120)]);
    return { ok: true };
  },

  /** Logs in to the seller's SMTP and sends a real test email; marks the settings verified on success. */
  async email_settings_test({ p_store_id, p_to }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const to = String(p_to || '').trim();
    if (!EMAIL_RE.test(to)) return { ok: false, error: 'Adresse de test invalide' };
    const s = await ctx.one('SELECT * FROM public.store_email_settings WHERE store_id=$1', [p_store_id]);
    if (!sellerSmtpReady(s)) return { ok: false, error: 'Enregistrez d’abord vos réglages SMTP' };
    try {
      const smtp = smtpOf(s);
      await nodemailer.createTransport({ host: smtp.smtp_host, port: Number(smtp.smtp_port), secure: !!smtp.smtp_secure,
        auth: { user: smtp.smtp_user, pass: smtp.smtp_pass }, connectionTimeout: 15000, greetingTimeout: 15000 }).verify();
      await sendSmtp(smtp, { to, subject: 'Test e-mail marketing', text: 'Votre serveur SMTP fonctionne.', html: '<p>Votre serveur SMTP fonctionne. ✅</p>' });
      await ctx.q('UPDATE public.store_email_settings SET verified_at=now() WHERE store_id=$1', [p_store_id]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  },

  async email_campaign_save({ p_store_id, p_id = null, p_campaign }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const c = campaign(p_campaign);
    const vals = [p_store_id, c.name, c.subject, c.preheader, c.accent, JSON.stringify(c.blocks)];
    if (p_id) {
      const row = await ctx.one(`UPDATE public.store_email_campaigns SET name=$2, subject=$3, preheader=$4, accent=$5, blocks=$6::jsonb, updated_at=now()
        WHERE id=$7 AND store_id=$1 AND status='draft' RETURNING *`, [...vals, id(p_id)]);
      if (!row) throw forbidden('Seuls les brouillons peuvent être modifiés');
      return row;
    }
    const n = await ctx.one('SELECT count(*)::int AS n FROM public.store_email_campaigns WHERE store_id=$1', [p_store_id]);
    if ((n?.n ?? 0) >= MAX_CAMPAIGNS) throw badRequest(`Maximum ${MAX_CAMPAIGNS} campagnes`);
    return ctx.one(`INSERT INTO public.store_email_campaigns(store_id, name, subject, preheader, accent, blocks) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`, vals);
  },

  async email_campaign_delete({ p_store_id, p_id }, ctx) {
    await permission(ctx, p_store_id, PERM);
    await ctx.q(`DELETE FROM public.store_email_campaigns WHERE id=$1 AND store_id=$2 AND status <> 'sending'`, [id(p_id), p_store_id]);
    return null;
  },

  async email_campaign_test({ p_store_id, p_campaign, p_to }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const to = String(p_to || '').trim();
    if (!EMAIL_RE.test(to)) return { ok: false, error: 'Adresse de test invalide' };
    const c = campaign(p_campaign);
    if (!c.subject) return { ok: false, error: 'Objet requis' };
    const s = await ctx.one('SELECT * FROM public.store_email_settings WHERE store_id=$1', [p_store_id]);
    if (!sellerSmtpReady(s)) return { ok: false, error: 'Configurez d’abord votre SMTP' };
    const shop = await ctx.one('SELECT store_name FROM public.platform_stores WHERE id=$1', [p_store_id]);
    const args = { ...c, shopName: shop?.store_name || '', name: 'Sarra Ben Ali' };
    try {
      await sendSmtp(smtpOf(s), { to, subject: `[TEST] ${c.subject}`, html: renderEmail(args), text: renderText(args) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  },

  /** Queues a draft for every shop customer with an email who has not unsubscribed. */
  async email_campaign_send({ p_store_id, p_id }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const s = await ctx.one('SELECT * FROM public.store_email_settings WHERE store_id=$1', [p_store_id]);
    if (!sellerSmtpReady(s) || !s.verified_at) throw badRequest('Testez votre SMTP avec succès avant d’envoyer une campagne');
    return ctx.tx(async (t) => {
      const c = await t.one(`SELECT * FROM public.store_email_campaigns WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id(p_id), p_store_id]);
      if (!c) throw badRequest('Campagne introuvable');
      if (c.status !== 'draft') throw badRequest('Cette campagne a déjà été envoyée');
      if (!c.subject || !sanitizeBlocks(c.blocks).length) throw badRequest('Ajoutez un objet et au moins un bloc');
      const rows = await t.q(`INSERT INTO public.store_email_recipients(campaign_id, store_id, email, name)
        SELECT $1, $2, lower(trim(c.email)), max(c.name) FROM public.clients c
        WHERE c.store_id=$2 AND c.email ~* '^[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+$'
          AND NOT EXISTS (SELECT 1 FROM public.store_email_unsubscribes u WHERE u.store_id=$2 AND u.email=lower(trim(c.email)))
        GROUP BY lower(trim(c.email)) ON CONFLICT DO NOTHING RETURNING id`, [c.id, p_store_id]);
      if (!rows.length) throw badRequest('Aucun client avec une adresse e-mail');
      await t.q(`UPDATE public.store_email_campaigns SET status='sending', total=$2, updated_at=now() WHERE id=$1`, [c.id, rows.length]);
      return { queued: rows.length };
    });
  },
};
