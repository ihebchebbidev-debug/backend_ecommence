// Pure A/B testing rules shared by the experiment RPCs and checkout pricing.
// No I/O here, so assignment, tokens, overrides and statistics are unit-testable.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { badRequest } from './errors.js';
import { isBot } from './visitInfo.js';

export const VARIANT_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
export const MAX_VARIANTS = VARIANT_KEYS.length;
export const METRICS = ['orders', 'confirmed', 'delivered_revenue', 'profit'];
export const MONEY_METRICS = ['delivered_revenue', 'profit'];
export const STATUSES = ['draft', 'running', 'paused', 'completed'];
export const TOKEN_TTL_S = 30 * 86_400;
export const PREVIEW_TTL_S = 86_400;
export const VERDICT_RULES = { minDays: 7, minVisitors: 100, minOrders: 15, winProb: 0.95 };
export const AUTO_STOP_PROB = 0.99;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR = /^[A-Za-z0-9_-]{8,64}$/;
export const validVisitor = (v) => typeof v === 'string' && VISITOR.test(v);
export const isPreviewAgent = (ua) => isBot(ua);

// ── Overrides (allow-listed product fields a variant may change) ────────────
const str = (max) => (v) => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > max ? undefined : s;
};
const num = (min, strict) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n > 1e9) return undefined;
  if (strict ? n <= min : n < min) return undefined;
  return Math.round(n * 1000) / 1000;
};
const url = (v) => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return '';
  return s.length <= 1000 && /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : undefined;
};
const urls = (v) => {
  if (!Array.isArray(v) || v.length > 50) return undefined;
  const out = v.map(url);
  return out.some((u) => u === undefined) ? undefined : out.filter(Boolean);
};
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (list) => (v) => (v === '' || v == null ? '' : list.includes(v) ? v : undefined);
export const CHECKOUT_POSITIONS = ['top', 'middle', 'bottom'];
/** Product columns a variant may change (validated, diffed, merged and written on apply). */
export const FIELDS = {
  name: { clean: str(200), message: 'Le nom du produit est invalide', required: true },
  price: { clean: num(0, true), message: 'Le prix doit être supérieur à 0' },
  compare_at_price: { clean: num(0, false), message: 'Le prix barré doit être positif ou nul' },
  delivery_fee: { clean: num(0, false), message: 'Les frais de livraison doivent être positifs ou nuls' },
  image_url: { clean: url, message: 'Image invalide' },
  gallery: { clean: urls, message: 'Galerie invalide (50 liens http(s) au maximum)' },
  short_description: { clean: str(1000), message: 'Résumé trop long' },
  description: { clean: str(20000), message: 'Description trop longue' },
  landing_only: { clean: bool, message: 'Mode page de vente invalide' },
  checkout_position: { clean: oneOf(CHECKOUT_POSITIONS), message: 'Position du formulaire invalide' },
};
export const FIELD_KEYS = Object.keys(FIELDS);
/** Variant-only extras that are not product columns. */
export const EXTRA_KEYS = ['bundles', 'reviews'];
const NUMERIC = ['price', 'compare_at_price', 'delivery_fee'];
const BUNDLE_FIELDS = {
  price: num(0, true), price_before_discount: num(0, false), name: str(120), label: str(120),
};
const same = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b) || typeof a === 'boolean' || typeof b === 'boolean') return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (typeof a === 'number' || typeof b === 'number') ? Number(a ?? 0) === Number(b ?? 0) : String(a ?? '') === String(b ?? '');
};

/** Product values for the allow-listed fields (numbers as numbers, gallery as a list). */
export function productValues(product) {
  const out = {};
  for (const k of FIELD_KEYS) {
    const v = product?.[k];
    if (NUMERIC.includes(k)) out[k] = Number(v ?? 0);
    else if (k === 'gallery') out[k] = Array.isArray(v) ? v : [];
    else if (k === 'landing_only') out[k] = v === true;
    else out[k] = v ?? '';
  }
  return out;
}

function cleanBundles(product, raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Offres groupées invalides', { code: 'AB_FIELD' });
  const known = new Map((product?.bundles || []).map((b) => [String(b.id), b]));
  const out = {};
  for (const [bid, changes] of Object.entries(raw)) {
    const base = known.get(bid);
    if (!base) throw badRequest('Offre groupée inconnue', { code: 'AB_FIELD' });
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw badRequest('Offres groupées invalides', { code: 'AB_FIELD' });
    const diff = {};
    for (const [k, v] of Object.entries(changes)) {
      const clean = BUNDLE_FIELDS[k];
      if (!clean) throw badRequest(`Champ non testable : ${k}`, { code: 'AB_FIELD' });
      const c = clean(v);
      if (c === undefined) throw badRequest('Prix d\'offre groupée invalide', { code: 'AB_FIELD' });
      if (!same(c, k === 'price' || k === 'price_before_discount' ? Number(base[k] ?? 0) : base[k])) diff[k] = c;
    }
    const price = diff.price ?? Number(base.price ?? 0), before = diff.price_before_discount ?? Number(base.price_before_discount ?? 0);
    if (('price' in diff || 'price_before_discount' in diff) && before > 0 && before <= price) throw badRequest('Le prix barré doit dépasser le prix de l\'offre', { code: 'AB_FIELD' });
    if (Object.keys(diff).length) out[bid] = diff;
  }
  return Object.keys(out).length ? out : null;
}
function cleanReviews(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.length > 50) throw badRequest('Avis invalides (50 au maximum)', { code: 'AB_FIELD' });
  const out = raw.map((r) => {
    const rating = Number(r?.rating);
    const comment = str(1000)(r?.comment), name = str(80)(r?.customer_name ?? '');
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) throw badRequest('La note doit être entre 0 et 5', { code: 'AB_FIELD' });
    if (!comment) throw badRequest('Chaque avis doit avoir un commentaire', { code: 'AB_FIELD' });
    if (name === undefined) throw badRequest('Nom du client trop long', { code: 'AB_FIELD' });
    return { customer_name: name, rating: Math.round(rating * 10) / 10, comment };
  });
  return out.length ? out : null;
}

/** Validate a full or partial variant copy and keep only fields that differ from the product. */
export function diffOverrides(product, values) {
  if (values == null) return { overrides: {}, changeKeys: [] };
  if (typeof values !== 'object' || Array.isArray(values)) throw badRequest('Variante invalide');
  const base = productValues(product);
  const overrides = {};
  for (const [k, raw] of Object.entries(values)) {
    if (k === 'bundles') { const b = cleanBundles(product, raw); if (b) overrides.bundles = b; continue; }
    if (k === 'reviews') { const r = cleanReviews(raw); if (r) overrides.reviews = r; continue; }
    const f = FIELDS[k];
    if (!f) throw badRequest(`Champ non testable : ${k}`, { code: 'AB_FIELD' });
    const v = f.clean(raw);
    if (v === undefined || (f.required && v === '')) throw badRequest(f.message, { code: 'AB_FIELD' });
    if (k === 'checkout_position' && v === '' && !base[k]) continue;
    if (!same(v, base[k])) overrides[k] = v;
  }
  const price = overrides.price ?? base.price, compare = overrides.compare_at_price ?? base.compare_at_price;
  if (('price' in overrides || 'compare_at_price' in overrides) && compare > 0 && compare <= price) throw badRequest('Le prix barré doit être supérieur au prix', { code: 'AB_FIELD' });
  const image = overrides.image_url ?? base.image_url, gallery = overrides.gallery ?? base.gallery;
  if (('image_url' in overrides || 'gallery' in overrides) && !image && !gallery.length) throw badRequest('Gardez au moins une image', { code: 'AB_FIELD' });
  if (JSON.stringify(overrides).length > 60_000) throw badRequest('Trop de changements', { code: 'AB_TOO_LARGE' });
  return { overrides, changeKeys: Object.keys(overrides) };
}

/** Product as a variant visitor sees it; localized names follow the tested name. */
export function applyOverrides(product, overrides) {
  if (!overrides || typeof overrides !== 'object') return product;
  const out = { ...product };
  for (const k of FIELD_KEYS) {
    if (!(k in overrides)) continue;
    out[k] = overrides[k];
    if (LOCALIZED.includes(k)) { out[`${k}_fr`] = overrides[k]; out[`${k}_ar`] = overrides[k]; }
  }
  return out;
}
export const LOCALIZED = ['name', 'description', 'short_description'];

/**
 * What applying a winner writes: product columns (localized copies follow when the
 * product has them), bundle price/label changes, and reviews to publish.
 */
export function productUpdatesFor(product, overrides) {
  const columns = {};
  for (const k of FIELD_KEYS) {
    if (!(k in (overrides || {}))) continue;
    columns[k] = overrides[k] === '' && k === 'checkout_position' ? null : overrides[k];
    if (LOCALIZED.includes(k)) for (const l of ['fr', 'ar']) if (product?.[`${k}_${l}`]) columns[`${k}_${l}`] = overrides[k];
  }
  return { columns, bundles: overrides?.bundles || {}, reviews: overrides?.reviews || [] };
}

// ── Variants and traffic ────────────────────────────────────────────────────
/** Normalise the editor's variant list: A is the control, then B, C… in order. */
export function normalizeVariants(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_VARIANTS) throw badRequest('Il faut de 2 à 11 variantes', { code: 'AB_VARIANTS' });
  return list.map((v, i) => {
    const key = VARIANT_KEYS[i];
    if (v?.key != null && v.key !== key) throw badRequest('Ordre des variantes invalide', { code: 'AB_VARIANTS' });
    const pct = v?.traffic_pct;
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) throw badRequest('Chaque variante doit avoir 1 à 99 % du trafic', { code: 'AB_TRAFFIC' });
    const name = typeof v?.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 60) : (i === 0 ? 'Original' : `Variante ${key}`);
    if (i === 0 && v?.values && Object.keys(v.values).length) throw badRequest('La variante contrôle ne peut pas avoir de changements', { code: 'AB_CONTROL' });
    return { key, name, is_control: i === 0, traffic_pct: pct, values: i === 0 ? null : (v?.values ?? {}) };
  });
}
export function assertTrafficTotal(variants) {
  const total = variants.reduce((s, v) => s + v.traffic_pct, 0);
  if (total !== 100) throw badRequest(`Le total du trafic doit faire 100 % (actuellement ${total} %)`, { code: 'AB_TRAFFIC' });
}
export function assertStartable(variants) {
  assertTrafficTotal(variants);
  for (const v of variants) if (!v.is_control && !(v.change_keys?.length)) throw badRequest('Chaque variante challenger doit avoir au moins un changement', { code: 'AB_NO_CHANGE' });
}
/** Even split; the remainder goes to the first variants so the total is exactly 100. */
export function evenSplit(n) {
  const base = Math.floor(100 / n), extra = 100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// ── Assignment ──────────────────────────────────────────────────────────────
export function bucketOf(experimentId, visitorId) {
  return parseInt(createHash('sha256').update(`${experimentId}:${visitorId}`).digest('hex').slice(0, 12), 16) % 10_000;
}
/** Deterministic variant for a bucket against cumulative traffic slices. */
export function pickVariant(variants, bucket) {
  let edge = 0;
  for (const v of variants) { edge += v.traffic_pct * 100; if (bucket < edge) return v.key; }
  return variants[variants.length - 1].key;
}

// ── Signed tokens ───────────────────────────────────────────────────────────
const sign = (secret, body) => createHmac('sha256', `ab:${secret}`).update(body).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function signAssignment(secret, experimentId, key, visitorId, now = Date.now()) {
  const body = `v1.${experimentId}.${key}.${visitorId}.${Math.floor(now / 1000) + TOKEN_TTL_S}`;
  return `${body}.${sign(secret, body)}`;
}
export function signPreview(secret, experimentId, key, now = Date.now()) {
  const body = `p1.${experimentId}.${key}.${Math.floor(now / 1000) + PREVIEW_TTL_S}`;
  return `${body}.${sign(secret, body)}`;
}
function verify(secret, token, kind, parts, now) {
  if (typeof token !== 'string' || token.length > 300) return null;
  const bits = token.split('.');
  if (bits.length !== parts || bits[0] !== kind) return null;
  const sig = bits.pop();
  if (!safeEq(sign(secret, bits.join('.')), sig)) return null;
  if (Number(bits[bits.length - 1]) * 1000 < now) return null;
  if (!UUID.test(bits[1]) || !VARIANT_KEYS.includes(bits[2])) return null;
  return bits;
}
export function verifyAssignment(secret, token, now = Date.now()) {
  const b = verify(secret, token, 'v1', 6, now);
  return b && validVisitor(b[3]) ? { experimentId: b[1], key: b[2], visitorId: b[3] } : null;
}
export function verifyPreview(secret, token, now = Date.now()) {
  const b = verify(secret, token, 'p1', 5, now);
  return b ? { experimentId: b[1], key: b[2] } : null;
}

// ── Statistics ──────────────────────────────────────────────────────────────
/** Small seeded PRNG so verdicts are stable between refreshes. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(rand) { let u = 0; while (u === 0) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); }
function gamma(shape, rand) {
  if (shape < 1) return gamma(shape + 1, rand) * Math.pow(rand() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rand); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaSample(a, b, rand) { const x = gamma(a, rand); return x / (x + gamma(b, rand)); }
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : null;

/**
 * Beta-Binomial (prior Beta(1,1)) comparison of conversion rates.
 * arms: [{ key, successes, trials }]; returns per key the chance to beat the control,
 * the chance to be the best, and the median relative lift with a 95 % interval.
 */
export function compareRates(arms, controlKey, { draws = 20_000, seed = 1 } = {}) {
  const rand = rng(seed);
  const ctrl = arms.findIndex((a) => a.key === controlKey);
  const best = arms.map(() => 0), beat = arms.map(() => 0), lifts = arms.map(() => []);
  for (let i = 0; i < draws; i += 1) {
    const s = arms.map((a) => betaSample(1 + a.successes, 1 + Math.max(0, a.trials - a.successes), rand));
    let top = 0; for (let j = 1; j < s.length; j += 1) if (s[j] > s[top]) top = j;
    best[top] += 1;
    s.forEach((x, j) => { if (j === ctrl) return; if (x > s[ctrl]) beat[j] += 1; lifts[j].push(s[ctrl] > 0 ? x / s[ctrl] - 1 : 0); });
  }
  return Object.fromEntries(arms.map((a, j) => {
    const l = lifts[j].sort((x, y) => x - y);
    return [a.key, {
      probBest: best[j] / draws,
      probBeatControl: j === ctrl ? null : beat[j] / draws,
      lift: j === ctrl ? null : quantile(l, 0.5),
      liftLow: j === ctrl ? null : quantile(l, 0.025),
      liftHigh: j === ctrl ? null : quantile(l, 0.975),
    }];
  }));
}

function lnGamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1; let x = 0.99999999999980993; for (let i = 0; i < 8; i += 1) x += g[i] / (z + i + 1);
  const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
/** Upper regularized incomplete gamma Q(a, x). */
function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n += 1) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}
/** Sample-ratio check: chi-square p-value of observed visitors against the planned split. */
export function srmPValue(observed, pcts) {
  const n = observed.reduce((s, v) => s + v, 0);
  if (n === 0 || observed.length < 2) return 1;
  const chi = observed.reduce((s, o, i) => { const e = n * pcts[i] / 100; return e > 0 ? s + (o - e) ** 2 / e : s; }, 0);
  return gammaQ((observed.length - 1) / 2, chi / 2);
}

/**
 * Verdict shown to the seller. Before the minimum days/visitors/orders: "collecting".
 * Then "winner" when one variant has ≥ winProb chance of being the best, otherwise "no_clear_winner".
 */
export function verdict({ days, variants, probabilities, srmP }, rules = VERDICT_RULES) {
  const minVisitors = Math.min(...variants.map((v) => v.visitors));
  const orders = variants.reduce((s, v) => s + v.orders, 0);
  const progress = { days, minDays: rules.minDays, minVisitors, needVisitors: rules.minVisitors, orders, needOrders: rules.minOrders };
  if (srmP < 0.001) return { state: 'srm', progress };
  if (days < rules.minDays || minVisitors < rules.minVisitors || orders < rules.minOrders) return { state: 'collecting', progress };
  const leader = Object.entries(probabilities).sort((a, b) => b[1].probBest - a[1].probBest)[0];
  if (leader && leader[1].probBest >= rules.winProb) return { state: 'winner', key: leader[0], prob: leader[1].probBest, progress };
  return { state: 'no_clear_winner', key: leader?.[0] ?? null, prob: leader?.[1].probBest ?? null, progress };
}

const rate = (n, d) => (d > 0 ? n / d : null);
/**
 * Turn per-variant counters into the results object (rates, verdict, split check).
 * counts[key] may carry money values per buying visitor (`delivered_values`, `profit_values`) and funnel counts.
 */
export function buildResults({ experiment, variants, counts, daily = [], days, now = Date.now(), compareMoney = null, draws = 20_000 }) {
  const control = variants.find((v) => v.is_control)?.key ?? 'A';
  const rows = variants.map((v) => {
    const c = counts[v.key] || {};
    const visitors = c.visitors || 0, orders = c.orders || 0, ordering = c.ordering || 0;
    const confirmed = c.confirmed || 0, delivered = c.delivered || 0, returned = c.returned || 0;
    const anomaly = ordering > visitors;
    return {
      key: v.key, name: v.name, is_control: v.is_control, traffic_pct: v.traffic_pct, change_keys: v.change_keys || [],
      visitors, orders, ordering_visitors: ordering, conversion_anomaly: anomaly,
      conversion_rate: anomaly ? null : rate(ordering, visitors),
      confirmed, rejected: c.rejected || 0, awaiting: Math.max(0, orders - confirmed - (c.rejected || 0)),
      confirmation_rate: rate(confirmed, orders),
      delivered, returned, delivery_rate: rate(delivered, delivered + returned),
      revenue_all: c.revenue_all || 0, revenue_delivered: c.revenue_delivered || 0, profit: Math.round((c.profit || 0) * 1000) / 1000,
      aov_all: rate(c.revenue_all || 0, orders), aov_delivered: rate(c.revenue_delivered || 0, delivered),
      revenue_per_visitor: rate(c.revenue_delivered || 0, visitors), profit_per_visitor: rate(c.profit || 0, visitors),
      funnel: { view: c.view || 0, add_to_cart: c.add_to_cart || 0, checkout_started: c.checkout_started || 0, phone_captured: c.phone_captured || 0, orders, confirmed, delivered },
      _money: { delivered_revenue: c.delivered_values || [], profit: c.profit_values || [] },
    };
  });
  const metric = METRICS.includes(experiment.primary_metric) ? experiment.primary_metric : 'orders';
  const seed = parseInt(String(experiment.id).replace(/-/g, '').slice(0, 8), 16) || 1;
  let probabilities;
  if (MONEY_METRICS.includes(metric) && compareMoney) {
    probabilities = compareMoney(rows.map((r) => ({ key: r.key, visitors: r.visitors, values: r._money[metric] })), control, { seed, draws: Math.min(draws, 4000) });
  } else {
    const arms = rows.map((r) => ({ key: r.key, trials: r.visitors, successes: Math.min(r.visitors, metric === 'confirmed' ? r.confirmed : r.ordering_visitors) }));
    probabilities = compareRates(arms, control, { seed, draws });
  }
  const srmP = srmPValue(rows.map((r) => r.visitors), rows.map((r) => r.traffic_pct));
  const totals = rows.reduce((t, r) => ({
    visitors: t.visitors + r.visitors, orders: t.orders + r.orders, confirmed: t.confirmed + r.confirmed,
    delivered: t.delivered + r.delivered, returned: t.returned + r.returned,
    revenue_all: t.revenue_all + r.revenue_all, revenue_delivered: t.revenue_delivered + r.revenue_delivered, profit: t.profit + r.profit,
  }), { visitors: 0, orders: 0, confirmed: 0, delivered: 0, returned: 0, revenue_all: 0, revenue_delivered: 0, profit: 0 });
  const clean = rows.map(({ _money, ...r }) => ({ ...r, ...probabilities[r.key] }));
  return {
    experiment_id: experiment.id, control_key: control, primary_metric: metric, days_running: days,
    generated_at: new Date(now).toISOString(), timezone: 'Africa/Tunis',
    totals: { ...totals, profit: Math.round(totals.profit * 1000) / 1000, confirmation_rate: rate(totals.confirmed, totals.orders), delivery_rate: rate(totals.delivered, totals.delivered + totals.returned) },
    variants: clean,
    srm_p: srmP, srm_warning: srmP < 0.001,
    verdict: verdict({ days, variants: rows, probabilities, srmP }),
    daily,
  };
}
