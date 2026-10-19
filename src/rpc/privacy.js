// Seller privacy controls: delete orders by period (1/day, support-restorable for 10 days) and data export requests (1/24h, valid 7 days).
import { badRequest, forbidden } from '../lib/errors.js';
import { validatePeriod, todayIn } from '../lib/privacyPeriod.js';
import { sendMail } from '../lib/mailer.js';
import { config } from '../config.js';

function cleanTz(v) {
  let tz = String(v || '').replace(/^"|"$/g, '') || 'Africa/Tunis';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'Africa/Tunis'; }
  return tz;
}

async function ownedStore(ctx, storeId) {
  ctx.requireAuth();
  if (!ctx.userId) throw forbidden('A user session is required');
  if (!(await ctx.isActiveUser())) throw forbidden('Account unavailable');
  const s = await ctx.one('SELECT id, store_name, user_id FROM public.platform_stores WHERE id = $1 AND deleted_at IS NULL', [storeId]);
  if (!s || s.user_id !== ctx.userId) throw forbidden('Seul le propriétaire de la boutique peut faire cela');
  const tz = await ctx.one(`SELECT value FROM public.store_settings WHERE store_id = $1 AND key = 'timezone'`, [storeId]);
  return { ...s, timezone: cleanTz(tz?.value) };
}

async function myEmail(ctx) {
  const p = await ctx.one('SELECT email FROM public.profiles WHERE id = $1', [ctx.userId]);
  if (p?.email) return p.email;
  const u = await ctx.one('SELECT email FROM auth.users WHERE id = $1', [ctx.userId]).catch(() => null);
  return u?.email || null;
}

function itemTable(kind) {
  if (kind === 'clients') return 'clients';
  if (kind === 'products') return 'products';
  throw badRequest('Type de données invalide');
}

const lastExport = (ctx) => ctx.one('SELECT * FROM public.privacy_export_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [ctx.userId]);

export default {
  async privacy_overview({ p_store_id }, ctx) {
    const store = await ownedStore(ctx, p_store_id);
    const deletions = await ctx.q(`SELECT id, period_from::text, period_to::text, include_payments, deleted_count, created_at, restore_until, restored_at
      FROM public.privacy_order_deletions WHERE store_id = $1 ORDER BY created_at DESC LIMIT 20`, [p_store_id]);
    const last = deletions[0];
    const exports = await ctx.q(`SELECT id, created_at, expires_at, email_sent, downloaded_at FROM public.privacy_export_requests
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [ctx.userId]);
    const total = await ctx.one('SELECT coalesce(sum(deleted_count),0)::int AS n FROM public.privacy_order_deletions WHERE store_id = $1 AND restored_at IS NULL', [p_store_id]);
    return {
      timezone: store.timezone,
      today: todayIn(store.timezone),
      email: await myEmail(ctx),
      deleted_total: total?.n ?? 0,
      deletions,
      next_deletion_at: last && Date.now() - new Date(last.created_at).getTime() < 86400000 ? new Date(new Date(last.created_at).getTime() + 86400000).toISOString() : null,
      exports,
      next_export_at: exports[0] && Date.now() - new Date(exports[0].created_at).getTime() < 86400000 ? new Date(new Date(exports[0].created_at).getTime() + 86400000).toISOString() : null,
    };
  },

  async privacy_count_orders({ p_store_id, p_from, p_to }, ctx) {
    const store = await ownedStore(ctx, p_store_id);
    const err = validatePeriod(p_from, p_to, todayIn(store.timezone));
    if (err) throw badRequest(err);
    const r = await ctx.one(`SELECT count(*)::int AS n FROM public.orders WHERE store_id = $1 AND deleted_at IS NULL
      AND created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND created_at < ($3::date + 1)::timestamp AT TIME ZONE $4`, [p_store_id, p_from, p_to, store.timezone]);
    return { count: r?.n ?? 0 };
  },

  async privacy_delete_orders({ p_store_id, p_from, p_to, p_include_payments = false }, ctx) {
    const store = await ownedStore(ctx, p_store_id);
    const err = validatePeriod(p_from, p_to, todayIn(store.timezone));
    if (err) throw badRequest(err);
    return ctx.tx(async (t) => {
      await t.one('SELECT id FROM public.platform_stores WHERE id = $1 FOR UPDATE', [p_store_id]);
      const recent = await t.one(`SELECT 1 AS x FROM public.privacy_order_deletions WHERE store_id = $1 AND created_at > now() - interval '24 hours' LIMIT 1`, [p_store_id]);
      if (recent) throw badRequest('Une seule suppression par jour est autorisée');
      const rows = await t.q(`SELECT id, payment_ref, payment_provider FROM public.orders WHERE store_id = $1 AND deleted_at IS NULL
        AND created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND created_at < ($3::date + 1)::timestamp AT TIME ZONE $4 FOR UPDATE`, [p_store_id, p_from, p_to, store.timezone]);
      if (!rows.length) throw badRequest('Aucune commande sur cette période');
      const ids = rows.map((r) => r.id);
      const snapshot = p_include_payments === true ? rows.filter((r) => r.payment_ref || r.payment_provider) : [];
      await t.q(`UPDATE public.orders SET deleted_at = now(), deleted_by = $2${p_include_payments === true ? ', payment_ref = NULL' : ''} WHERE id = ANY($1::uuid[])`, [ids, ctx.userId]);
      const rec = await t.one(`INSERT INTO public.privacy_order_deletions (store_id, user_id, period_from, period_to, timezone, include_payments, order_ids, payment_snapshot, deleted_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8::jsonb,$9) RETURNING id, deleted_count, restore_until`,
        [p_store_id, ctx.userId, p_from, p_to, store.timezone, p_include_payments === true, ids, JSON.stringify(snapshot), ids.length]);
      return rec;
    });
  },

  /** Count customers ('clients') or products created in a period. */
  async privacy_count_items({ p_store_id, p_kind, p_from, p_to }, ctx) {
    const store = await ownedStore(ctx, p_store_id);
    const table = itemTable(p_kind);
    const err = validatePeriod(p_from, p_to, todayIn(store.timezone));
    if (err) throw badRequest(err);
    const r = await ctx.one(`SELECT count(*)::int AS n FROM public.${table} WHERE store_id = $1 ${table === 'products' ? "AND coalesce(status,'') <> 'deleted'" : ''}
      AND created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND created_at < ($3::date + 1)::timestamp AT TIME ZONE $4`, [p_store_id, p_from, p_to, store.timezone]);
    return { count: r?.n ?? 0 };
  },

  /** Customers: unlinked from their orders (orders are kept) then removed, snapshot kept 10 days.
   *  Products: hidden from shop and seller lists (status 'deleted'); order history stays intact. */
  async privacy_delete_items({ p_store_id, p_kind, p_from, p_to }, ctx) {
    const store = await ownedStore(ctx, p_store_id);
    const table = itemTable(p_kind);
    const err = validatePeriod(p_from, p_to, todayIn(store.timezone));
    if (err) throw badRequest(err);
    return ctx.tx(async (t) => {
      await t.one('SELECT id FROM public.platform_stores WHERE id = $1 FOR UPDATE', [p_store_id]);
      const recent = await t.one(`SELECT 1 AS x FROM public.privacy_data_deletions WHERE store_id = $1 AND kind = $2 AND created_at > now() - interval '24 hours' LIMIT 1`, [p_store_id, p_kind]);
      if (recent) throw badRequest('Une seule suppression par jour est autorisée');
      const rows = await t.q(`SELECT * FROM public.${table} WHERE store_id = $1 ${table === 'products' ? "AND coalesce(status,'') <> 'deleted'" : ''}
        AND created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND created_at < ($3::date + 1)::timestamp AT TIME ZONE $4 FOR UPDATE`, [p_store_id, p_from, p_to, store.timezone]);
      if (!rows.length) throw badRequest(table === 'clients' ? 'Aucun client sur cette période' : 'Aucun produit sur cette période');
      const ids = rows.map((r) => r.id);
      if (table === 'clients') {
        await t.q('UPDATE public.orders SET client_id = NULL WHERE client_id = ANY($1::uuid[]) AND store_id = $2', [ids, p_store_id]);
        await t.q('DELETE FROM public.clients WHERE id = ANY($1::uuid[]) AND store_id = $2', [ids, p_store_id]);
      } else {
        await t.q(`UPDATE public.products SET status = 'deleted', updated_at = now() WHERE id = ANY($1::uuid[]) AND store_id = $2`, [ids, p_store_id]);
      }
      const snapshot = table === 'clients' ? rows : rows.map((r) => ({ id: r.id, status: r.status }));
      return t.one(`INSERT INTO public.privacy_data_deletions (store_id, user_id, kind, period_from, period_to, timezone, item_ids, snapshot, deleted_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8::jsonb,$9) RETURNING id, kind, deleted_count, restore_until`,
        [p_store_id, ctx.userId, p_kind, p_from, p_to, store.timezone, ids, JSON.stringify(snapshot), ids.length]);
    });
  },

  async privacy_item_deletions({ p_store_id }, ctx) {
    await ownedStore(ctx, p_store_id);
    return ctx.q(`SELECT id, kind, period_from::text, period_to::text, deleted_count, created_at, restore_until, restored_at
      FROM public.privacy_data_deletions WHERE store_id = $1 ORDER BY created_at DESC LIMIT 40`, [p_store_id]);
  },

  async privacy_request_export(_args, ctx) {
    ctx.requireAuth();
    if (!ctx.userId) throw forbidden('A user session is required');
    const last = await lastExport(ctx);
    if (last && Date.now() - new Date(last.created_at).getTime() < 86400000) throw badRequest('Un seul export toutes les 24 h');
    const email = await myEmail(ctx);
    const req = await ctx.one('INSERT INTO public.privacy_export_requests (user_id, email) VALUES ($1,$2) RETURNING id, created_at, expires_at', [ctx.userId, email]);
    let sent = false;
    if (email) {
      const link = `${String(config.publicUrl || '').replace(/\/$/, '')}/app/privacy`;
      try {
        await sendMail({ to: email, subject: 'Votre export de données est prêt',
          text: `Votre export est prêt. Téléchargez-le ici (valable 7 jours) : ${link}`,
          html: `<p>Votre export de données est prêt.</p><p><a href="${link}">Télécharger mon export</a> — lien valable 7 jours.</p>` });
        sent = true;
      } catch { sent = false; }
      if (sent) await ctx.q('UPDATE public.privacy_export_requests SET email_sent = true WHERE id = $1', [req.id]);
    }
    return { ...req, email_sent: sent };
  },

  async privacy_export_data({ p_request_id }, ctx) {
    ctx.requireAuth();
    if (!ctx.userId) throw forbidden('A user session is required');
    const req = await ctx.one('SELECT * FROM public.privacy_export_requests WHERE id = $1 AND user_id = $2', [p_request_id, ctx.userId]);
    if (!req) throw forbidden('Export introuvable');
    if (new Date(req.expires_at).getTime() < Date.now()) throw badRequest('Ce lien a expiré, demandez un nouvel export');
    const profile = await ctx.one('SELECT id, full_name, email, phone, country, created_at FROM public.profiles WHERE id = $1', [ctx.userId]);
    const stores = await ctx.q('SELECT * FROM public.platform_stores WHERE user_id = $1 AND deleted_at IS NULL', [ctx.userId]);
    const ids = stores.map((s) => s.id);
    const products = ids.length ? await ctx.q('SELECT * FROM public.products WHERE store_id = ANY($1::uuid[])', [ids]) : [];
    const orders = ids.length ? await ctx.q('SELECT * FROM public.orders WHERE store_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at', [ids]) : [];
    await ctx.q('UPDATE public.privacy_export_requests SET downloaded_at = now() WHERE id = $1', [req.id]);
    const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !/secret|token|password|key/i.test(k)));
    return { generated_at: new Date().toISOString(), account: profile, shops: stores.map(strip), products, orders };
  },
};
