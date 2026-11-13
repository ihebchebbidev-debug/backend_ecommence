// A/B testing RPCs. Sellers create/run/end experiments on a product, a sales page or
// the COD order form (products permission) and read results (statistics permission).
// Shops call resolve_storefront_experiment / resolve_page_experiment / resolve_form_experiment
// to get the visitor's sticky variant.
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { id, text, publicStore } from '../lib/commerce.js';
import { config } from '../config.js';
import { isBot, parseUserAgent } from '../lib/visitInfo.js';
import {
  METRICS, STATUSES, normalizeVariants, assertTrafficTotal, assertStartable, diffOverrides, productValues, productUpdatesFor,
  applyOverrides, bucketOf, pickVariant, signAssignment, verifyAssignment, signPreview, verifyPreview, validVisitor, compareRates, verdict,
} from '../lib/experiments.js';
import { TARGETS, diffTarget, loadTarget, targetValues, writeTarget, normalizeFieldRules } from '../lib/experimentTargets.js';
import { computeResults, filterOptions } from '../lib/experimentResults.js';
import { resultsCsv } from '../lib/experimentStats.js';

const MANAGE = 'canManageProducts';
const STATS = 'canViewAnalytics';
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const loose = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a ?? 0) === Number(b ?? 0) : same(a ?? '', b ?? ''));

async function access(ctx, storeId, keys) {
  ctx.requireAuth();
  if (!ctx.userId && !ctx.isServiceRole) throw forbidden('A user session is required');
  if (!(await ctx.isActiveUser())) throw forbidden('Account unavailable');
  await ctx.assertStoreAccess(id(storeId));
  for (const k of keys) if (await ctx.hasStorePermission(storeId, k)) return k;
  throw forbidden(keys.includes(STATS) && keys.length === 1 ? 'Il faut la permission de voir les statistiques' : 'Il faut la permission de gérer les produits', { code: 'AB_PERMISSION' });
}

export async function loadExperiment(db, storeId, experimentId, lock = false) {
  const e = await db.one(`SELECT * FROM public.store_experiments WHERE id=$1 AND store_id=$2${lock ? ' FOR UPDATE' : ''}`, [id(experimentId), storeId]);
  if (!e) throw notFound('Expérience introuvable', { code: 'AB_NOT_FOUND' });
  e.variants = await db.q('SELECT key, name, is_control, traffic_pct, overrides, change_keys, source_snapshot FROM public.store_experiment_variants WHERE experiment_id=$1 ORDER BY key', [e.id]);
  return e;
}
async function loadProduct(db, storeId, productId, lock = false) {
  const p = await db.one(`SELECT id, store_id, name, name_fr, name_ar, price::float8 AS price, compare_at_price::float8 AS compare_at_price, delivery_fee::float8 AS delivery_fee,
      image_url, gallery, landing_only, checkout_position, description, description_fr, description_ar, short_description, short_description_fr, short_description_ar, status
     FROM public.products WHERE id=$1 AND store_id=$2 AND coalesce(status,'active') <> 'deleted'${lock ? ' FOR UPDATE' : ''}`, [id(productId), storeId]);
  if (!p) throw badRequest("Ce produit n'existe plus", { code: 'AB_PRODUCT' });
  p.bundles = await db.q(`SELECT id, name, label, price::float8 AS price, coalesce(price_before_discount,0)::float8 AS price_before_discount, quantity
    FROM public.product_bundles WHERE product_id=$1 ORDER BY sort_order, id`, [p.id]);
  return p;
}
/** The product, sales page or form an experiment changes. */
async function loadSubject(db, storeId, e, lock = false) {
  return e.target_type === 'product' || !e.target_type ? loadProduct(db, storeId, e.product_id, lock) : loadTarget(db, storeId, e.target_type, e.sales_page_id, lock);
}
const subjectValues = (type, s) => (type === 'product' ? productValues(s) : targetValues(type, s));
const diffFor = (type, s, values) => (type === 'product' ? diffOverrides(s, values) : diffTarget(type, s, values));
function versionGuard(e, version) {
  if (version != null && Number(version) !== e.version) throw conflict("L'expérience a changé entre-temps, rechargez", { code: 'AB_VERSION' });
}
const busy = (err) => {
  if (err?.code === '23505' && /active_(product|page|form)/.test(String(err.constraint || err.message))) {
    const what = /page/.test(String(err.constraint || err.message)) ? 'Cette page de vente a déjà une expérience active' : /form/.test(String(err.constraint || err.message)) ? 'Le formulaire de commande a déjà une expérience active' : 'Ce produit a déjà une expérience active';
    throw conflict(what, { code: 'AB_ACTIVE_EXISTS' });
  }
  if (err?.code === '55P03' || err?.code === '40001') throw conflict('Expérience occupée, réessayez', { code: 'AB_BUSY' });
  throw err;
};

function present(e, subject = null) {
  const type = e.target_type || 'product';
  const current = subject ? subjectValues(type, subject) : null;
  return {
    id: e.id, store_id: e.store_id, name: e.name, status: e.status, target_type: type, product_id: e.product_id, sales_page_id: e.sales_page_id,
    primary_metric: e.primary_metric, started_at: e.started_at, paused_at: e.paused_at, ended_at: e.ended_at,
    winner_key: e.winner_key, applied_winner: e.applied_winner, applied_fields: e.applied_fields || null, backup_product_id: e.backup_product_id,
    auto_stop: !!e.auto_stop, auto_stopped: !!e.auto_stopped, winner_history: e.winner_history || [],
    version: e.version, created_at: e.created_at, updated_at: e.updated_at,
    variants: (e.variants || []).map((v) => {
      const snap = v.source_snapshot || {};
      return {
        key: v.key, name: v.name, is_control: v.is_control, traffic_pct: v.traffic_pct, overrides: v.overrides || {}, change_keys: v.change_keys || [],
        // Original edited since the experiment started / now equal to the variant.
        source_changed: current ? (v.change_keys || []).filter((k) => k in snap && k in current && !loose(snap[k], current[k])) : [],
        caught_up: current ? (v.change_keys || []).filter((k) => k in current && loose((v.overrides || {})[k], current[k])) : [],
      };
    }),
    product: subject && type === 'product' ? {
      id: subject.id, name: subject.name, image_url: subject.image_url, status: subject.status, values: current,
      bundles: (subject.bundles || []).map((b) => ({ id: b.id, name: b.name, label: b.label, price: b.price, price_before_discount: b.price_before_discount, quantity: b.quantity })),
    } : null,
    target: subject && type !== 'product' ? { id: subject.id ?? null, name: subject.name ?? null, values: current } : null,
  };
}

async function writeVariants(t, experimentId, variants) {
  await t.q('DELETE FROM public.store_experiment_variants WHERE experiment_id=$1', [experimentId]);
  for (const v of variants) {
    await t.q(`INSERT INTO public.store_experiment_variants (experiment_id, key, name, is_control, traffic_pct, overrides, change_keys)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::text[])`, [experimentId, v.key, v.name, v.is_control, v.traffic_pct, JSON.stringify(v.overrides || {}), v.change_keys || []]);
  }
}

// ── Applying / reverting a winner ────────────────────────────────────────────
const JSON_COLS = ['gallery'];
async function setProduct(t, productId, columns) {
  const sets = [], params = [productId];
  for (const [col, v] of Object.entries(columns)) { params.push(JSON_COLS.includes(col) ? JSON.stringify(v ?? null) : v); sets.push(`${col}=$${params.length}${JSON_COLS.includes(col) ? '::jsonb' : ''}`); }
  if (sets.length) await t.q(`UPDATE public.products SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, params);
}
/** Writes the winner's changes; returns the undo record stored in applied_fields. */
async function applyWinner(t, storeId, e, winner, subject) {
  const ov = winner.overrides || {};
  if (e.target_type && e.target_type !== 'product') return { target: await writeTarget(t, storeId, e.target_type, subject, ov) };
  const up = productUpdatesFor(subject, ov);
  const columns = {};
  for (const [col, v] of Object.entries(up.columns)) columns[col] = { old: subject[col] ?? null, new: v };
  await setProduct(t, subject.id, up.columns);
  const bundles = {};
  for (const [bid, changes] of Object.entries(up.bundles)) {
    const base = (subject.bundles || []).find((b) => String(b.id) === bid);
    if (!base) continue;
    const sets = [], params = [bid, subject.id];
    bundles[bid] = {};
    for (const [k, v] of Object.entries(changes)) { params.push(v); sets.push(`${k}=$${params.length}`); bundles[bid][k] = { old: base[k] ?? null, new: v }; }
    await t.q(`UPDATE public.product_bundles SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 AND product_id=$2`, params);
  }
  const reviews = [];
  for (const [i, r] of up.reviews.entries()) {
    const row = await t.one(`INSERT INTO public.product_reviews (product_id, customer_name, rating, comment, status, sort_order) VALUES ($1,$2,$3,$4,'published',$5) RETURNING id`,
      [subject.id, r.customer_name || null, r.rating, r.comment, i]);
    reviews.push(row.id);
  }
  return { columns, bundles, reviews };
}
/** Legacy completed experiments stored a flat { column: { old, new } } record. */
const undoRecord = (a) => (!a ? null : a.columns || a.target || a.bundles || a.reviews ? a : { columns: a });
/**
 * Puts back the original only where the live value still equals what the winner wrote;
 * fields edited by hand since are kept. dry=true only reports.
 */
async function revertWinner(t, storeId, e, subject, dry = false) {
  const rec = undoRecord(e.applied_fields);
  const reverted = [], kept = [];
  if (!rec) return { reverted, kept };
  if (rec.target) {
    const live = targetValues(e.target_type, subject), back = {};
    for (const [k, { old, new: nv }] of Object.entries(rec.target)) (same(live[k], nv) ? (back[k] = old, reverted) : kept).push(k);
    if (!dry && Object.keys(back).length) await writeTarget(t, storeId, e.target_type, subject, e.target_type === 'checkout_form' ? { field_rules: normalizeFieldRules(back.field_rules) } : back);
    return { reverted, kept };
  }
  const cols = {};
  for (const [col, { old, new: nv }] of Object.entries(rec.columns || {})) (loose(subject[col], nv) ? (cols[col] = old, reverted) : kept).push(col);
  if (!dry) await setProduct(t, subject.id, cols);
  for (const [bid, fields] of Object.entries(rec.bundles || {})) {
    const live = (subject.bundles || []).find((b) => String(b.id) === bid);
    if (!live) continue;
    const sets = [], params = [bid, subject.id];
    for (const [k, { old, new: nv }] of Object.entries(fields)) {
      if (loose(live[k], nv)) { params.push(old); sets.push(`${k}=$${params.length}`); reverted.push(`bundles.${k}`); } else kept.push(`bundles.${k}`);
    }
    if (!dry && sets.length) await t.q(`UPDATE public.product_bundles SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 AND product_id=$2`, params);
  }
  if ((rec.reviews || []).length) {
    reverted.push('reviews');
    if (!dry) await t.q('DELETE FROM public.product_reviews WHERE product_id=$1 AND id = ANY($2::uuid[])', [subject.id, rec.reviews]);
  }
  return { reverted: [...new Set(reverted)], kept: [...new Set(kept)] };
}
async function backupProduct(t, productId) {
  return (await t.one(`INSERT INTO public.products
      SELECT (jsonb_populate_record(NULL::public.products, to_jsonb(p) || jsonb_build_object('id', gen_random_uuid(), 'name', left(p.name || ' (original)', 200),
        'status', 'draft', 'stock', 0, 'created_at', now(), 'updated_at', now()))).*
      FROM public.products p WHERE p.id=$1 RETURNING id`, [productId])).id;
}
const applyFailed = (err) => {
  if (err?.status) throw err;
  throw conflict("Impossible d'appliquer le gagnant. L'expérience continue.", { code: 'AB_APPLY_FAILED' });
};

// ── Visitor assignment ──────────────────────────────────────────────────────
const perIp = new Map();
function resolveLimited(ip, now = Date.now()) {
  if (!ip) return false;
  if (perIp.size > 20_000) perIp.clear();
  const e = perIp.get(ip);
  if (!e || now - e.since > 10 * 60_000) { perIp.set(ip, { n: 1, since: now }); return false; }
  e.n += 1;
  return e.n > 600;
}
export const rateLimited = (ip) => resolveLimited(String(ip || ''));
const cleanTag = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 150) : null);
const ORIGINAL = { experiment_id: null, variant_key: null, overrides: null, token: null, preview: false };

/** Shared sticky assignment for a running experiment (null = show the original). */
async function assign(ctx, experimentId, visitorId, abToken, meta) {
  const ua = String(ctx.requestHeaders?.['user-agent'] || '');
  if (isBot(ua) || !validVisitor(visitorId)) return null;
  if (resolveLimited(String(ctx.requestIp || ''))) return null;
  const variants = await ctx.q('SELECT key, is_control, traffic_pct, overrides FROM public.store_experiment_variants WHERE experiment_id=$1 ORDER BY key', [experimentId]);
  if (variants.length < 2) return null;
  const known = await ctx.one('SELECT variant_key FROM public.store_experiment_exposures WHERE experiment_id=$1 AND visitor_id=$2', [experimentId, visitorId]);
  const tok = verifyAssignment(config.jwtSecret, abToken);
  let key = known?.variant_key
    || (tok && tok.experimentId === experimentId && tok.visitorId === visitorId && variants.some((v) => v.key === tok.key) ? tok.key : null)
    || pickVariant(variants, bucketOf(experimentId, visitorId));
  if (!variants.some((v) => v.key === key)) key = variants[0].key;
  const m = meta && typeof meta === 'object' ? meta : {};
  const row = await ctx.one(`INSERT INTO public.store_experiment_exposures (experiment_id, visitor_id, variant_key, device, utm_source, utm_campaign, ad_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (experiment_id, visitor_id) DO UPDATE SET last_seen_at=now() RETURNING variant_key`,
    [experimentId, visitorId, key, parseUserAgent(ua).device || null, cleanTag(m.utm_source), cleanTag(m.utm_campaign), cleanTag(m.ad_id)]);
  key = row?.variant_key || key;
  const v = variants.find((x) => x.key === key);
  // Re-use a still-valid token so checkout retries keep the same request content.
  const token = tok && tok.experimentId === experimentId && tok.key === key && tok.visitorId === visitorId ? abToken : signAssignment(config.jwtSecret, experimentId, key, visitorId);
  return { experiment_id: experimentId, variant_key: key, overrides: v.is_control ? {} : v.overrides, token, preview: false };
}
async function previewFor(ctx, storeId, token, where, params) {
  const p = token ? verifyPreview(config.jwtSecret, token) : null;
  if (!p) return null;
  const v = await ctx.one(`SELECT v.key, v.is_control, v.overrides FROM public.store_experiments e JOIN public.store_experiment_variants v ON v.experiment_id=e.id AND v.key=$3
    WHERE e.id=$1 AND e.store_id=$2 AND ${where}`, [p.experimentId, storeId, p.key, ...params]);
  return v ? { ...ORIGINAL, experiment_id: p.experimentId, variant_key: v.key, overrides: v.is_control ? {} : v.overrides, preview: true } : null;
}

/** Cheap verdict for the list's "probable winner" column. */
async function leaderFor(db, storeId, e) {
  const rows = await db.q(`SELECT v.key, v.is_control, v.traffic_pct,
      (SELECT count(*)::int FROM public.store_experiment_exposures x WHERE x.experiment_id=v.experiment_id AND x.variant_key=v.key) AS visitors,
      (SELECT count(*)::int FROM public.orders o WHERE o.store_id=$2 AND o.experiment_id=v.experiment_id AND o.experiment_variant=v.key AND o.deleted_at IS NULL AND coalesce(o.status,'') <> 'abandoned') AS orders,
      (SELECT count(*)::int FROM public.orders o WHERE o.store_id=$2 AND o.experiment_id=v.experiment_id AND o.experiment_variant=v.key AND o.deleted_at IS NULL AND coalesce(o.status,'') <> 'abandoned'
         AND (o.confirmed_at IS NOT NULL OR o.status IN ('confirmed','shipped','transit','in_transit','delivered','returned'))) AS confirmed
    FROM public.store_experiment_variants v WHERE v.experiment_id=$1 ORDER BY v.key`, [e.id, storeId]);
  if (rows.length < 2) return null;
  const control = rows.find((r) => r.is_control)?.key ?? 'A';
  const useConfirmed = e.primary_metric === 'confirmed';
  const probs = compareRates(rows.map((r) => ({ key: r.key, trials: r.visitors, successes: Math.min(r.visitors, useConfirmed ? r.confirmed : r.orders) })), control, { draws: 2000, seed: 7 });
  const days = e.started_at ? Math.floor((((e.ended_at ? new Date(e.ended_at) : new Date()) - new Date(e.started_at)) / 86_400_000)) + 1 : 0;
  const v = verdict({ days, variants: rows, probabilities: probs, srmP: 1 });
  return { state: v.state, key: v.key ?? null, prob: v.prob ?? null };
}

const api = {
  /** experiments_list(p_store_id, p_status?, p_product_id?, p_search?) → { counts, items } */
  async experiments_list({ p_store_id, p_status = null, p_product_id = null, p_search = '' }, ctx) {
    await access(ctx, p_store_id, [MANAGE, STATS]);
    const status = STATUSES.includes(p_status) ? p_status : null;
    const product = p_product_id ? id(p_product_id) : null;
    const term = `%${String(p_search || '').trim().slice(0, 80).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const counts = await ctx.one(`SELECT count(*)::int AS all,
        count(*) FILTER (WHERE status='running')::int AS running, count(*) FILTER (WHERE status='paused')::int AS paused,
        count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE status='draft')::int AS draft,
        count(*) FILTER (WHERE applied_winner)::int AS winners_applied
      FROM public.store_experiments WHERE store_id=$1`, [p_store_id]);
    const items = await ctx.q(`SELECT e.id, e.name, e.status, e.target_type, e.product_id, e.sales_page_id, e.primary_metric, p.name AS product_name, p.image_url AS product_image, sp.name AS page_name, sp.slug AS sales_page_slug,
        e.started_at, e.ended_at, e.winner_key, e.applied_winner, e.auto_stop, e.auto_stopped, e.version, e.updated_at, e.created_at,
        coalesce((SELECT array_agg(DISTINCT k) FROM public.store_experiment_variants v, unnest(v.change_keys) k WHERE v.experiment_id=e.id), '{}') AS change_keys,
        (SELECT count(*)::int FROM public.store_experiment_variants v WHERE v.experiment_id=e.id) AS variant_count,
        (SELECT count(*)::int FROM public.store_experiment_exposures x WHERE x.experiment_id=e.id) AS visitors
      FROM public.store_experiments e LEFT JOIN public.products p ON p.id=e.product_id LEFT JOIN public.store_sales_pages sp ON sp.id=e.sales_page_id AND sp.store_id=e.store_id
     WHERE e.store_id=$1 AND ($2::text IS NULL OR e.status=$2) AND ($3::uuid IS NULL OR e.product_id=$3)
       AND (e.name ILIKE $4 OR coalesce(p.name,'') ILIKE $4 OR coalesce(sp.name,'') ILIKE $4)
     ORDER BY (e.status IN ('running','paused')) DESC, e.updated_at DESC LIMIT 200`, [p_store_id, status, product, term]);
    for (const it of items) {
      it.target_name = it.target_type === 'sales_page' ? it.page_name : it.target_type === 'checkout_form' ? null : it.product_name;
      it.leader = it.status === 'completed' ? (it.winner_key ? { state: 'winner', key: it.winner_key, prob: null } : null)
        : it.status === 'draft' ? null : await leaderFor(ctx, p_store_id, it).catch(() => null);
    }
    return { store_id: p_store_id, counts, items };
  },

  /** experiment_get(p_store_id, p_id) → experiment with variants and the live product/page/form values. */
  async experiment_get({ p_store_id, p_id }, ctx) {
    await access(ctx, p_store_id, [MANAGE, STATS]);
    const e = await loadExperiment(ctx, p_store_id, p_id);
    return present(e, await loadSubject(ctx, p_store_id, e).catch(() => null));
  },

  /**
   * experiment_save(p_store_id, p_id?, p_version?, p_name, p_target_type='product', p_product_id?, p_sales_page_id?,
   *   p_primary_metric, p_auto_stop?, p_variants[{key,name,traffic_pct,values}])
   * Draft: everything; running/paused: name, variant names, traffic and auto-stop only. The server keeps only fields that differ.
   */
  async experiment_save({ p_store_id, p_id = null, p_version = null, p_name, p_target_type = 'product', p_product_id = null, p_sales_page_id = null,
    p_primary_metric = 'orders', p_auto_stop = null, p_variants }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    const name = text(p_name, 120, true);
    const metric = METRICS.includes(p_primary_metric) ? p_primary_metric : 'orders';
    const variants = normalizeVariants(p_variants);
    return ctx.tx(async (t) => {
      let e = p_id ? await loadExperiment(t, p_store_id, p_id, true) : null;
      if (e) versionGuard(e, p_version);
      if (e?.status === 'completed') throw conflict('Une expérience terminée ne peut plus être modifiée', { code: 'AB_LOCKED' });
      const autoStop = typeof p_auto_stop === 'boolean' ? p_auto_stop : !!e?.auto_stop;
      if (!e || e.status === 'draft') {
        // The target type is chosen on the first save and never changes afterwards.
        const type = e ? e.target_type : (TARGETS.includes(p_target_type) ? p_target_type : 'product');
        const productId = type === 'product' ? id(p_product_id) : null;
        const pageId = type === 'sales_page' ? id(p_sales_page_id) : null;
        const subject = type === 'product' ? await loadProduct(t, p_store_id, productId) : await loadTarget(t, p_store_id, type, pageId);
        const rows = variants.map((v) => (v.is_control ? { ...v, overrides: {}, change_keys: [] } : (() => { const d = diffFor(type, subject, v.values); return { ...v, overrides: d.overrides, change_keys: d.changeKeys }; })()));
        if (!e) {
          e = await t.one(`INSERT INTO public.store_experiments (store_id, name, target_type, product_id, sales_page_id, primary_metric, auto_stop, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [p_store_id, name, type, productId, pageId, metric, autoStop, ctx.userId || null]);
        } else {
          e = await t.one(`UPDATE public.store_experiments SET name=$3, product_id=$4, sales_page_id=$5, primary_metric=$6, auto_stop=$7, version=version+1, updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING *`,
            [e.id, p_store_id, name, productId, pageId, metric, autoStop]);
        }
        await writeVariants(t, e.id, rows);
      } else {
        // Started: contents are locked; only names, auto-stop and the split for new visitors may change.
        if (variants.length !== e.variants.length) throw conflict('Les variantes ne peuvent plus changer après le démarrage', { code: 'AB_LOCKED' });
        assertTrafficTotal(variants);
        for (const v of variants) await t.q('UPDATE public.store_experiment_variants SET name=$3, traffic_pct=$4 WHERE experiment_id=$1 AND key=$2', [e.id, v.key, v.name, v.traffic_pct]);
        e = await t.one('UPDATE public.store_experiments SET name=$3, auto_stop=$4, version=version+1, updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING *', [e.id, p_store_id, name, autoStop]);
      }
      const saved = await loadExperiment(t, p_store_id, e.id);
      return present(saved, await loadSubject(t, p_store_id, saved).catch(() => null));
    }).catch(busy);
  },

  /** experiment_set_auto_stop(p_store_id, p_id, p_auto_stop, p_version?) — opt in/out of ending at 99 % (winner never applied automatically). */
  async experiment_set_auto_stop({ p_store_id, p_id, p_auto_stop, p_version = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    if (typeof p_auto_stop !== 'boolean') throw badRequest('Valeur invalide');
    return ctx.tx(async (t) => {
      const e = await loadExperiment(t, p_store_id, p_id, true);
      versionGuard(e, p_version);
      if (e.status === 'completed') throw conflict('Une expérience terminée ne peut plus être modifiée', { code: 'AB_LOCKED' });
      await t.q('UPDATE public.store_experiments SET auto_stop=$2, version=version+1, updated_at=now() WHERE id=$1', [e.id, p_auto_stop]);
      return present(await loadExperiment(t, p_store_id, e.id));
    }).catch(busy);
  },

  /** experiment_start(p_store_id, p_id, p_version) — draft → running; visitors are split immediately. */
  async experiment_start({ p_store_id, p_id, p_version = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    return ctx.tx(async (t) => {
      const e = await loadExperiment(t, p_store_id, p_id, true);
      versionGuard(e, p_version);
      if (e.status !== 'draft') throw conflict('Seul un brouillon peut démarrer', { code: 'AB_STATE' });
      const subject = await loadSubject(t, p_store_id, e);
      // Re-check against the target as it is now: fields the original caught up with are dropped.
      const rows = e.variants.map((v) => {
        if (v.is_control) return { ...v, overrides: {}, change_keys: [] };
        const d = diffFor(e.target_type, subject, v.overrides);
        return { ...v, overrides: d.overrides, change_keys: d.changeKeys };
      });
      assertStartable(rows);
      await writeVariants(t, e.id, rows);
      await t.q('UPDATE public.store_experiment_variants SET source_snapshot=$2::jsonb WHERE experiment_id=$1', [e.id, JSON.stringify(subjectValues(e.target_type, subject))]);
      await t.one(`UPDATE public.store_experiments SET status='running', started_at=now(), paused_at=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING id`, [e.id]);
      return present(await loadExperiment(t, p_store_id, e.id), subject);
    }).catch(busy);
  },

  /** experiment_pause — everyone sees the original until resumed; assignments are kept. */
  async experiment_pause({ p_store_id, p_id, p_version = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    return ctx.tx(async (t) => {
      const e = await loadExperiment(t, p_store_id, p_id, true);
      versionGuard(e, p_version);
      if (e.status !== 'running') throw conflict("L'expérience n'est pas en cours", { code: 'AB_STATE' });
      await t.q(`UPDATE public.store_experiments SET status='paused', paused_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [e.id]);
      return present(await loadExperiment(t, p_store_id, e.id));
    }).catch(busy);
  },

  /** experiment_resume — paused → running; checkout prices are recomputed by the server. */
  async experiment_resume({ p_store_id, p_id, p_version = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    return ctx.tx(async (t) => {
      const e = await loadExperiment(t, p_store_id, p_id, true);
      versionGuard(e, p_version);
      if (e.status !== 'paused') throw conflict("L'expérience n'est pas en pause", { code: 'AB_STATE' });
      await loadSubject(t, p_store_id, e);
      await t.q(`UPDATE public.store_experiments SET status='running', paused_at=NULL, version=version+1, updated_at=now() WHERE id=$1`, [e.id]);
      return present(await loadExperiment(t, p_store_id, e.id));
    }).catch(busy);
  },

  /**
   * experiment_complete(p_store_id, p_id, p_winner_key, p_apply=true, p_backup=false, p_version)
   * One transaction under the shop lock: optional hidden copy of the original product, then the winner's
   * changes are written. On any failure nothing is written and the experiment keeps running.
   */
  async experiment_complete({ p_store_id, p_id, p_winner_key, p_apply = true, p_backup = false, p_version = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    try {
      return await ctx.tx(async (t) => {
        await t.one('SELECT id FROM public.platform_stores WHERE id=$1 FOR UPDATE', [p_store_id]);
        const e = await loadExperiment(t, p_store_id, p_id, true);
        versionGuard(e, p_version);
        if (!['running', 'paused'].includes(e.status)) throw conflict("Arrêtez une expérience en cours ou en pause", { code: 'AB_STATE' });
        const winner = e.variants.find((v) => v.key === p_winner_key);
        if (!winner) throw badRequest('Gagnant invalide', { code: 'AB_WINNER' });
        const apply = !winner.is_control && p_apply !== false && Object.keys(winner.overrides || {}).length > 0;
        let backupId = null, applied = null, subject = null;
        if (apply) {
          subject = await loadSubject(t, p_store_id, e, true);
          if (p_backup === true && e.target_type === 'product') backupId = await backupProduct(t, subject.id);
          applied = await applyWinner(t, p_store_id, e, winner, subject);
        }
        await t.q(`UPDATE public.store_experiments SET status='completed', ended_at=now(), paused_at=NULL, winner_key=$2, applied_winner=$3,
            applied_fields=$4::jsonb, backup_product_id=$5, winner_history=winner_history || $6::jsonb, version=version+1, updated_at=now() WHERE id=$1`,
          [e.id, winner.key, apply, applied ? JSON.stringify(applied) : null, backupId, JSON.stringify([{ key: winner.key, applied: apply, at: new Date().toISOString() }])]);
        return present(await loadExperiment(t, p_store_id, e.id), apply ? await loadSubject(t, p_store_id, e) : null);
      });
    } catch (err) { return applyFailed(err); }
  },

  /** experiment_winner_preview(p_store_id, p_id, p_winner_key?) — what a winner change / restore would revert, keep and apply. */
  async experiment_winner_preview({ p_store_id, p_id, p_winner_key = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    const e = await loadExperiment(ctx, p_store_id, p_id);
    if (e.status !== 'completed') throw conflict("L'expérience n'est pas terminée", { code: 'AB_STATE' });
    const subject = await loadSubject(ctx, p_store_id, e);
    const { reverted, kept } = e.applied_winner ? await revertWinner(ctx, p_store_id, e, subject, true) : { reverted: [], kept: [] };
    const next = p_winner_key ? e.variants.find((v) => v.key === p_winner_key) : null;
    if (p_winner_key && !next) throw badRequest('Gagnant invalide', { code: 'AB_WINNER' });
    return { reverted, kept, apply: next && !next.is_control ? next.change_keys || [] : [] };
  },

  /**
   * experiment_change_winner(p_store_id, p_id, p_winner_key, p_version) and experiment_restore_original(p_store_id, p_id, p_version)
   * Completed only. Fields the previous winner wrote go back to the original only if nobody edited them since
   * (those are kept and returned in `kept`), then the new winner is applied. One transaction under the shop lock.
   */
  async experiment_change_winner({ p_store_id, p_id, p_winner_key, p_version = null }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    try {
      return await ctx.tx(async (t) => {
        await t.one('SELECT id FROM public.platform_stores WHERE id=$1 FOR UPDATE', [p_store_id]);
        const e = await loadExperiment(t, p_store_id, p_id, true);
        versionGuard(e, p_version);
        if (e.status !== 'completed') throw conflict("L'expérience n'est pas terminée", { code: 'AB_STATE' });
        const winner = p_winner_key == null ? e.variants.find((v) => v.is_control) : e.variants.find((v) => v.key === p_winner_key);
        if (!winner) throw badRequest('Gagnant invalide', { code: 'AB_WINNER' });
        let subject = await loadSubject(t, p_store_id, e, true);
        const { reverted, kept } = e.applied_winner ? await revertWinner(t, p_store_id, e, subject) : { reverted: [], kept: [] };
        const apply = !winner.is_control && Object.keys(winner.overrides || {}).length > 0;
        let applied = null;
        if (apply) { subject = await loadSubject(t, p_store_id, e, true); applied = await applyWinner(t, p_store_id, e, winner, subject); }
        await t.q(`UPDATE public.store_experiments SET winner_key=$2, applied_winner=$3, applied_fields=$4::jsonb, winner_history=winner_history || $5::jsonb,
            version=version+1, updated_at=now() WHERE id=$1`,
          [e.id, winner.key, apply, applied ? JSON.stringify(applied) : null, JSON.stringify([{ key: winner.key, applied: apply, kept, at: new Date().toISOString() }])]);
        return { ...present(await loadExperiment(t, p_store_id, e.id), await loadSubject(t, p_store_id, e)), reverted, kept };
      });
    } catch (err) {
      if (err?.status) throw err;
      throw conflict("Impossible de changer le gagnant. Rien n'a été modifié.", { code: 'AB_APPLY_FAILED' });
    }
  },
  async experiment_restore_original({ p_store_id, p_id, p_version = null }, ctx) {
    return api.experiment_change_winner({ p_store_id, p_id, p_winner_key: null, p_version }, ctx);
  },

  /** experiment_delete — drafts and completed experiments only (irreversible). */
  async experiment_delete({ p_store_id, p_id }, ctx) {
    await access(ctx, p_store_id, [MANAGE]);
    return ctx.tx(async (t) => {
      const e = await loadExperiment(t, p_store_id, p_id, true);
      if (!['draft', 'completed'].includes(e.status)) throw conflict("Arrêtez l'expérience avant de la supprimer", { code: 'AB_STATE' });
      await t.q('DELETE FROM public.store_experiments WHERE id=$1 AND store_id=$2', [e.id, p_store_id]);
      return { deleted: true, id: e.id };
    });
  },

  /** experiment_preview_token(p_store_id, p_id, p_key) → signed 24 h link token that forces a variant without counting. */
  async experiment_preview_token({ p_store_id, p_id, p_key }, ctx) {
    await access(ctx, p_store_id, [MANAGE, STATS]);
    const e = await loadExperiment(ctx, p_store_id, p_id);
    if (!e.variants.some((v) => v.key === p_key)) throw badRequest('Variante inconnue');
    let slug = null;
    if (e.target_type === 'sales_page') slug = (await ctx.one('SELECT slug FROM public.store_sales_pages WHERE id=$1 AND store_id=$2', [e.sales_page_id, p_store_id]))?.slug ?? null;
    return { token: signPreview(config.jwtSecret, e.id, p_key), target_type: e.target_type, product_id: e.product_id, sales_page_id: e.sales_page_id, sales_page_slug: slug };
  },

  /** experiment_results(p_store_id, p_id, p_source?, p_device?) — counts, funnel, chance to win, split check and daily curve. */
  async experiment_results({ p_store_id, p_id, p_source = null, p_device = null }, ctx) {
    await access(ctx, p_store_id, [STATS]);
    const e = await loadExperiment(ctx, p_store_id, p_id);
    const results = await computeResults(ctx, p_store_id, e, { source: p_source, device: p_device });
    return { store_id: p_store_id, status: e.status, auto_stop: !!e.auto_stop, options: await filterOptions(ctx, e.id), ...results };
  },

  /** experiment_results_csv(p_store_id, p_id, p_source?, p_device?) → { filename, csv } */
  async experiment_results_csv({ p_store_id, p_id, p_source = null, p_device = null }, ctx) {
    await access(ctx, p_store_id, [STATS]);
    const e = await loadExperiment(ctx, p_store_id, p_id);
    const results = await computeResults(ctx, p_store_id, e, { source: p_source, device: p_device });
    const safe = e.name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'experience';
    return { filename: `ab-${safe}.csv`, csv: resultsCsv(results) };
  },

  /**
   * resolve_storefront_experiment(p_store_id, p_product_id, p_visitor_id, p_ab_token?, p_preview_token?, p_meta?)
   * Public. Robots and paused/ended experiments get the original; real visitors keep the variant they first got.
   */
  async resolve_storefront_experiment({ p_store_id, p_product_id, p_visitor_id, p_ab_token = null, p_preview_token = null, p_meta = null }, ctx) {
    await publicStore(ctx, p_store_id);
    const productId = id(p_product_id);
    const preview = await previewFor(ctx, p_store_id, p_preview_token, 'e.product_id=$4', [productId]);
    if (preview) return preview;
    const e = await ctx.one(`SELECT id FROM public.store_experiments WHERE store_id=$1 AND product_id=$2 AND target_type='product' AND status='running' LIMIT 1`, [p_store_id, productId]);
    return (e && await assign(ctx, e.id, p_visitor_id, p_ab_token, p_meta)) || ORIGINAL;
  },

  /** resolve_page_experiment(p_store_id, p_sales_page_id, …) — same rules for a sales page; overrides = page fields. */
  async resolve_page_experiment({ p_store_id, p_sales_page_id, p_visitor_id, p_ab_token = null, p_preview_token = null, p_meta = null }, ctx) {
    await publicStore(ctx, p_store_id);
    const pageId = id(p_sales_page_id);
    const preview = await previewFor(ctx, p_store_id, p_preview_token, "e.sales_page_id=$4 AND e.target_type='sales_page'", [pageId]);
    if (preview) return preview;
    const e = await ctx.one(`SELECT id FROM public.store_experiments WHERE store_id=$1 AND sales_page_id=$2 AND target_type='sales_page' AND status='running' LIMIT 1`, [p_store_id, pageId]);
    return (e && await assign(ctx, e.id, p_visitor_id, p_ab_token, p_meta)) || ORIGINAL;
  },

  /** resolve_form_experiment(p_store_id, …) — the shop's COD order-form test; overrides = { field_rules }. */
  async resolve_form_experiment({ p_store_id, p_visitor_id, p_ab_token = null, p_preview_token = null, p_meta = null }, ctx) {
    await publicStore(ctx, p_store_id);
    const preview = await previewFor(ctx, p_store_id, p_preview_token, "e.target_type='checkout_form' AND $4::int = 1", [1]);
    if (preview) return preview;
    const e = await ctx.one(`SELECT id FROM public.store_experiments WHERE store_id=$1 AND target_type='checkout_form' AND status='running' LIMIT 1`, [p_store_id]);
    return (e && await assign(ctx, e.id, p_visitor_id, p_ab_token, p_meta)) || ORIGINAL;
  },
};

export default api;
export { applyOverrides };
