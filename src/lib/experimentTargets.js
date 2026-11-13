// Sales-page and COD order-form experiments: what a variant may change, how it is
// diffed against the live page/form, and how a winner is written back.
import { badRequest } from './errors.js';
import { validateLandingContent } from './salesLanding.js';

export const TARGETS = ['product', 'sales_page', 'checkout_form'];
export const SALES_TEMPLATES = ['minimal', 'product', 'vsl', 'advertorial', 'quiz', 'upsell'];
/** Mirror of src/lib/checkoutFieldRules.ts (phone always stays required). */
const FORM_FIELDS = { name: ['required', 'optional'], address: ['required', 'optional', 'hidden'], governorate: ['required', 'optional', 'hidden'], city: ['required', 'optional', 'hidden'], notes: ['required', 'optional', 'hidden'] };
export const DEFAULT_FIELD_RULES = { name: 'required', address: 'required', governorate: 'optional', city: 'optional', notes: 'optional' };
export function normalizeFieldRules(raw) {
  const out = { ...DEFAULT_FIELD_RULES };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, allowed] of Object.entries(FORM_FIELDS)) if (allowed.includes(raw[k])) out[k] = raw[k];
  return out;
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Live values a variant starts from. */
export function targetValues(type, target) {
  if (type === 'sales_page') {
    const c = isObj(target?.content) ? target.content : {};
    return {
      headline: target?.headline ?? '', template: target?.template || 'minimal',
      body: typeof c.body === 'string' ? c.body : '', video_url: typeof c.video_url === 'string' ? c.video_url : '',
      question: typeof c.question === 'string' ? c.question : '', answers: Array.isArray(c.answers) ? c.answers : [],
      blocks: Array.isArray(c.blocks) ? c.blocks : [],
    };
  }
  return { field_rules: normalizeFieldRules(target?.field_rules) };
}

/** Page content as a variant visitor sees it. */
export function mergePage(page, overrides) {
  if (!isObj(overrides)) return page;
  const { headline, template, ...content } = overrides;
  return { ...page, ...(headline !== undefined ? { headline } : {}), ...(template ? { template } : {}), content: { ...(isObj(page?.content) ? page.content : {}), ...content } };
}

function cleanPage(target, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === 'headline' || k === 'body' || k === 'question') {
      if (typeof v !== 'string' || v.length > (k === 'body' ? 20000 : 300)) throw badRequest('Texte de page invalide', { code: 'AB_FIELD' });
      out[k] = v.trim();
    } else if (k === 'template') {
      if (!SALES_TEMPLATES.includes(v)) throw badRequest('Modèle de page invalide', { code: 'AB_FIELD' });
      out[k] = v;
    } else if (k === 'video_url') {
      if (typeof v !== 'string' || v.length > 2000 || (v && !/^https:\/\//i.test(v))) throw badRequest('Vidéo invalide', { code: 'AB_FIELD' });
      out[k] = v.trim();
    } else if (k === 'answers') {
      if (!Array.isArray(v) || v.length > 6 || v.some((a) => typeof a !== 'string' || a.length > 200)) throw badRequest('Réponses du quiz invalides', { code: 'AB_FIELD' });
      out[k] = v.map((a) => a.trim()).filter(Boolean);
    } else if (k === 'blocks') {
      out[k] = v;
    } else throw badRequest(`Champ non testable : ${k}`, { code: 'AB_FIELD' });
  }
  const merged = mergePage(target, out);
  // Same block rules as the page editor: ordered blocks, no arbitrary HTML, https media only.
  try { validateLandingContent(merged.content); } catch { throw badRequest('Contenu de page invalide', { code: 'AB_FIELD' }); }
  const c = merged.content;
  if (merged.template === 'vsl' && !c.video_url) throw badRequest('Le modèle vidéo demande une vidéo', { code: 'AB_FIELD' });
  if (merged.template === 'quiz' && (!String(c.question || '').trim() || new Set((c.answers || []).map((a) => a.trim())).size < 2)) throw badRequest('Le quiz demande une question et deux réponses', { code: 'AB_FIELD' });
  return out;
}

/** Validate a variant for a page/form target and keep only what differs from the live target. */
export function diffTarget(type, target, values) {
  if (values == null) return { overrides: {}, changeKeys: [] };
  if (!isObj(values)) throw badRequest('Variante invalide');
  const base = targetValues(type, target);
  let clean;
  if (type === 'sales_page') clean = cleanPage(target, values);
  else {
    const extra = Object.keys(values).find((k) => k !== 'field_rules');
    if (extra) throw badRequest(`Champ non testable : ${extra}`, { code: 'AB_FIELD' });
    clean = values.field_rules == null ? {} : { field_rules: normalizeFieldRules(values.field_rules) };
  }
  const overrides = {};
  for (const [k, v] of Object.entries(clean)) if (!same(v, base[k])) overrides[k] = v;
  if (JSON.stringify(overrides).length > 60_000) throw badRequest('Trop de changements', { code: 'AB_TOO_LARGE' });
  return { overrides, changeKeys: Object.keys(overrides) };
}

/** The page or form an experiment is about, scoped to the shop. */
export async function loadTarget(db, storeId, type, salesPageId, lock = false) {
  if (type === 'sales_page') {
    const p = await db.one(`SELECT id, store_id, name, headline, template, content, status, product_id FROM public.store_sales_pages WHERE id=$1 AND store_id=$2${lock ? ' FOR UPDATE' : ''}`, [salesPageId, storeId]);
    if (!p) throw badRequest("Cette page de vente n'existe plus", { code: 'AB_TARGET' });
    return p;
  }
  const f = await db.one(`SELECT field_rules FROM public.checkout_settings WHERE store_id=$1${lock ? ' FOR UPDATE' : ''}`, [storeId]);
  return { id: null, field_rules: f?.field_rules ?? null };
}

/** Write overrides to the live page/form; returns { field: { old, new } } for undo. */
export async function writeTarget(db, storeId, type, target, overrides) {
  const applied = {};
  if (type === 'sales_page') {
    const base = targetValues(type, target);
    for (const [k, v] of Object.entries(overrides)) applied[k] = { old: base[k], new: v };
    const merged = mergePage(target, overrides);
    await db.q('UPDATE public.store_sales_pages SET headline=$3, template=$4, content=$5::jsonb, updated_at=now() WHERE id=$1 AND store_id=$2',
      [target.id, storeId, merged.headline ?? null, merged.template, JSON.stringify(merged.content)]);
    return applied;
  }
  applied.field_rules = { old: normalizeFieldRules(target.field_rules), new: overrides.field_rules };
  const done = await db.q('UPDATE public.checkout_settings SET field_rules=$2::jsonb, updated_at=now() WHERE store_id=$1 RETURNING store_id', [storeId, JSON.stringify(overrides.field_rules)]);
  if (!done.length) await db.q('INSERT INTO public.checkout_settings (store_id, field_rules) VALUES ($1, $2::jsonb)', [storeId, JSON.stringify(overrides.field_rules)]);
  return applied;
}
