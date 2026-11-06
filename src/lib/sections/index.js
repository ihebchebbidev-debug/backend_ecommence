// Shared section rules for the shop builder. The frontend registry
// (src/storefront/builder/sections.ts) uses the same type names.
import { badRequest } from '../errors.js';

export const SECTION_TYPES = [
  'announcement', 'header', 'hero', 'category_tiles', 'featured_products', 'image_text',
  'countdown_banner', 'trust_badges', 'testimonials', 'logos', 'faq', 'newsletter',
  'rich_text', 'gallery', 'contact', 'footer', 'single_product', 'spacer',
  'product_main', 'related_products', 'collection_grid', 'custom_code', 'contact_form',
  'hero_slider', 'social_icons', 'order_confirmation', 'order_summary', 'next_steps',
  'review_wall', 'faq_cards', 'cta_banner', 'before_after', 'stock_urgency', 'how_it_works', 'comparison', 'benefits_grid', 'key_stats',
  'product_reviews', 'photo_reviews', 'frequently_bought', 'upsell_products', 'volume_discount', 'gift_boxes', 'cart_reminder', 'thank_you_upsell',
  'video', 'pricing_table', 'tabs', 'marquee', 'map', 'popup', 'team', 'timeline', 'social_feed', 'quote', 'collage', 'contact_cards', 'hotspots', 'feature_rows', 'split_faq',
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
  if (st._anchor != null) st._anchor = String(st._anchor).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
  for (const k of ['_hide_mobile', '_hide_desktop']) if (k in st) st[k] = !!st[k];
  // Layout: spacing (px), content width, alignment, corner radius.
  const num = (k, min, max) => { if (k in st) { const n = Number(st[k]); st[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : 0; } };
  num('_mt', -120, 200); num('_mb', -120, 200); num('_pt', 0, 200); num('_pb', 0, 200); num('_px', 0, 120); num('_radius', 0, 48);
  num('_ml', 0, 200); num('_mr', 0, 200); num('_pl', 0, 160); num('_pr', 0, 160); num('_gap', 0, 80); num('_maxw', 0, 1600);
  num('_bg_angle', 0, 360); num('_overlay', 0, 90); num('_border_w', 0, 12);
  if ('_bg_size' in st && !['cover', 'contain', 'auto', 'repeat'].includes(st._bg_size)) st._bg_size = 'cover';
  if ('_bg_pos' in st && !['center', 'top', 'bottom', 'left', 'right'].includes(st._bg_pos)) st._bg_pos = 'center';
  if ('_shadow' in st && !['', 'sm', 'md', 'lg'].includes(st._shadow)) st._shadow = '';
  if ('_bg_fixed' in st) st._bg_fixed = !!st._bg_fixed;
  if (typeof st._bg_image === 'string' && /["'()\\\s]/.test(st._bg_image)) st._bg_image = '';
  if ('_width' in st && !['', 'full', 'wide', 'normal', 'narrow'].includes(st._width)) st._width = '';
  if ('_anim' in st && !['none', 'fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'zoom', 'zoom-out', 'blur', 'flip'].includes(st._anim)) st._anim = 'none';
  num('_anim_dur', 100, 3000); num('_anim_delay', 0, 3000);
  if ('_anim_repeat' in st) st._anim_repeat = !!st._anim_repeat;
  if ('_align' in st && !['', 'left', 'center', 'right'].includes(st._align)) st._align = '';
  // Per-element styles: keys are structural CSS paths, so only the strict nth-of-type form is kept.
  if ('_el' in st) {
    const PATH = /^(?:[a-z][a-z0-9]{0,9}:nth-of-type\(\d{1,3}\)>){0,24}[a-z][a-z0-9]{0,9}:nth-of-type\(\d{1,3}\)$/;
    const raw = st._el && typeof st._el === 'object' && !Array.isArray(st._el) ? st._el : {};
    st._el = Object.fromEntries(Object.entries(raw).filter(([k, v]) => k.length <= 500 && PATH.test(k) && v && typeof v === 'object' && !Array.isArray(v)).slice(0, 40));
  }
  if ('_global_id' in st) st._global_id = String(st._global_id || '').replace(/[^\w-]/g, '').slice(0, 64);
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
