// Shared section rules for the shop builder. The frontend registry
// (src/storefront/builder/sections.ts) uses the same type names.
import { badRequest } from '../errors.js';

export const SECTION_TYPES = [
  'announcement', 'header', 'hero', 'category_tiles', 'featured_products', 'image_text',
  'countdown_banner', 'trust_badges', 'testimonials', 'logos', 'faq', 'newsletter',
  'rich_text', 'gallery', 'contact', 'footer', 'single_product', 'spacer',
  'product_main', 'related_products', 'collection_grid',
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

function cleanSection(sec, where) {
  if (!sec || typeof sec !== 'object') throw badRequest(`Section invalide (${where})`);
  if (!SECTION_TYPES.includes(sec.type)) throw badRequest(`Type de section inconnu: ${sec.type}`);
  const blocks = Array.isArray(sec.blocks) ? sec.blocks : [];
  if (blocks.length > LIMITS.maxBlocksPerSection) throw badRequest(`Trop d'éléments dans ${sec.type}`);
  return {
    id: String(sec.id || '').slice(0, 64) || Math.random().toString(36).slice(2, 10),
    type: sec.type,
    hidden: !!sec.hidden,
    settings: clean(sec.settings || {}, 'settings'),
    blocks: blocks.map((b) => clean(b, 'block')),
  };
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
    pages[handle] = title ? { title, sections: cleaned } : { sections: cleaned };
  }
  return {
    template: String(config.template || 'custom').slice(0, 40),
    version: 1,
    settings: clean(config.settings || {}, 'settings'),
    header: config.header ? cleanSection(config.header, 'header') : null,
    footer: config.footer ? cleanSection(config.footer, 'footer') : null,
    pages,
  };
}
