// Shared section rules for the shop builder. The frontend registry
// (src/storefront/builder/sections.ts) uses the same type names.
import { badRequest } from '../errors.js';

export const SECTION_TYPES = [
  'announcement', 'header', 'hero', 'category_tiles', 'featured_products', 'image_text',
  'countdown_banner', 'trust_badges', 'testimonials', 'logos', 'faq', 'newsletter',
  'rich_text', 'gallery', 'contact', 'footer', 'single_product', 'spacer',
  'product_main', 'related_products', 'collection_grid', 'custom_code', 'contact_form',
  'hero_slider', 'social_icons', 'order_confirmation', 'order_summary', 'next_steps',
  'review_wall', 'faq_cards', 'cta_banner',
];

export const LIMITS = { maxPages: 25, maxSectionsPerPage: 40, maxBlocksPerSection: 12, maxBytes: 200 * 1024, maxString: 4000 };

const HEX = /^#[0-9a-f]{3,8}$/i;
const URL_OK = /^(https?:\/\/|\/|#|mailto:|tel:)/i;

function clean(value, path) {
  if (typeof value === 'string') {
    // strip tags / scripts — rich text is plain paragraphs in v1
    let v = value.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '');
    if (v.length > LIMITS.maxString) v = v.slice(0, LIMITS.maxString);
    if (/(color|bg|background)$/i.test(path) && v && !HEX.test(v)) throw badRequest(`Couleur invalide: ${path}`);
    if (/(link|url|href|image|video)$/i.test(path) && v && !URL_OK.test(v)) throw badRequest(`Lien invalide: ${path}`);
    return v;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((x, i) => clean(x, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v, k);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

function cleanCodeSection(sec, raw) {
  if (sec.type !== 'custom_code') return sec;
  const html = typeof raw?.html === 'string' ? raw.html : '';
  const css = typeof raw?.css === 'string' ? raw.css : '';
  const js = typeof raw?.js === 'string' ? raw.js : '';
  if (html.length > 12000 || css.length > 8000 || js.length > 8000) throw badRequest('Code personnalisé trop long');
  sec.settings = { ...sec.settings, html, css, js };
  return sec;
}

// Shared "advanced" section settings: device visibility + anchor for #links.
function cleanAdvanced(st) {
  if (st._anchor != null) st._anchor = String(st._anchor).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  for (const k of ['_hide_mobile', '_hide_desktop']) if (k in st) st[k] = !!st[k];
  // Layout: spacing (px), content width, alignment, corner radius.
  const num = (k, min, max) => { if (k in st) { const n = Number(st[k]); st[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : 0; } };
  num('_mt', -120, 200); num('_mb', -120, 200); num('_pt', 0, 200); num('_pb', 0, 200); num('_px', 0, 120); num('_radius', 0, 48);
  if ('_width' in st && !['', 'full', 'wide', 'normal', 'narrow'].includes(st._width)) st._width = '';
  if ('_anim' in st && !['none', 'fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'zoom', 'zoom-out', 'blur', 'flip'].includes(st._anim)) st._anim = 'none';
  num('_anim_dur', 100, 3000); num('_anim_delay', 0, 3000);
  if ('_anim_repeat' in st) st._anim_repeat = !!st._anim_repeat;
  if ('_align' in st && !['', 'left', 'center', 'right'].includes(st._align)) st._align = '';
  return st;
}

function cleanSection(sec, where) {
  if (!sec || typeof sec !== 'object') throw badRequest(`Section invalide (${where})`);
  if (!SECTION_TYPES.includes(sec.type)) throw badRequest(`Type de section inconnu: ${sec.type}`);
  const blocks = Array.isArray(sec.blocks) ? sec.blocks : [];
  if (blocks.length > LIMITS.maxBlocksPerSection) throw badRequest(`Trop d'éléments dans ${sec.type}`);
  return cleanCodeSection({
    id: String(sec.id || '').slice(0, 64) || Math.random().toString(36).slice(2, 10),
    type: sec.type,
    hidden: !!sec.hidden,
    settings: cleanAdvanced(clean(sec.type === 'custom_code'
      ? Object.fromEntries(Object.entries(sec.settings || {}).filter(([k]) => !['html', 'css', 'js'].includes(k)))
      : sec.settings || {}, 'settings')),
    blocks: blocks.map((b) => clean(b, 'block')),
  }, sec.settings);
}

function assertUniqueIds(sections) {
  const sectionIds = new Set();
  for (const section of sections) {
    if (sectionIds.has(section.id)) throw badRequest(`Identifiant de section dupliqué: ${section.id}`);
    sectionIds.add(section.id);
    const blockIds = new Set();
    for (const block of section.blocks) {
      const id = typeof block?.id === 'string' ? block.id.trim() : '';
      if (!id) throw badRequest(`Élément sans identifiant dans ${section.type}`);
      if (blockIds.has(id)) throw badRequest(`Identifiant d'élément dupliqué dans ${section.type}: ${id}`);
      blockIds.add(id);
    }
  }
}

/** Validate + sanitize a full builder configuration. Throws 400 on bad input. */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw badRequest('Configuration manquante');
  if (Buffer.byteLength(JSON.stringify(config)) > LIMITS.maxBytes) throw badRequest('Configuration trop lourde (200 Ko max)');
  const pages = {};
  const entries = Object.entries(config.pages || {});
  if (entries.length > LIMITS.maxPages) throw badRequest(`Trop de pages (${LIMITS.maxPages} max)`);
  for (const [handle, page] of entries) {
    if (!/^[a-z0-9_-]{1,40}$/.test(handle)) throw badRequest(`Page invalide: ${handle}`);
    const sections = Array.isArray(page?.sections) ? page.sections : [];
    if (sections.length > LIMITS.maxSectionsPerPage) throw badRequest(`Trop de sections sur ${handle} (40 max)`);
    const cleaned = sections.map((s, i) => cleanSection(s, `${handle}#${i}`));
    if (handle !== 'product' && cleaned.some((s) => s.type === 'product_main')) throw badRequest('La fiche produit ne peut être placée que sur la page produit');
    const title = typeof page?.title === 'string' ? page.title.replace(/<[^>]*>/g, '').slice(0, 60) : undefined;
    const out = title ? { title, sections: cleaned } : { sections: cleaned };
    // Per-page SEO (search result title/description + social image).
    if (page?.seo && typeof page.seo === 'object') {
      const str = (v, max) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim().slice(0, max) : '');
      const seo = { title: str(page.seo.title, 70), description: str(page.seo.description, 160), image: str(page.seo.image, 500) };
      if (seo.image && !URL_OK.test(seo.image)) throw badRequest(`Image de partage invalide (${handle})`);
      if (seo.title || seo.description || seo.image) out.seo = seo;
    }
    pages[handle] = out;
  }
  const allSections = [config.header, config.footer, ...Object.values(pages).flatMap((page) => page.sections)].filter(Boolean);
  assertUniqueIds(allSections);
  return {
    template: String(config.template || 'custom').slice(0, 40),
    version: 1,
    settings: clean(config.settings || {}, 'settings'),
    header: config.header ? cleanSection(config.header, 'header') : null,
    footer: config.footer ? cleanSection(config.footer, 'footer') : null,
    pages,
  };
}
