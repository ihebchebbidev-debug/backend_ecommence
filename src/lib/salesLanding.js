import { badRequest } from './errors.js';
export function validateLandingContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Invalid sales content');
  for (const key of ['quick_order','capture_abandoned']) if (key in value && typeof value[key] !== 'boolean') throw badRequest('Invalid checkout setting');
  if ('page_width' in value && !['standard', 'narrow', 'phone'].includes(value.page_width)) throw badRequest('Invalid page width');
  if ('seamless_images' in value && typeof value.seamless_images !== 'boolean') throw badRequest('Invalid image spacing');
  if ('checkout_position' in value && !['after_product', 'before_content', 'after_content'].includes(value.checkout_position)) throw badRequest('Invalid checkout position');
  if (value.blocks == null) return;
  if (!Array.isArray(value.blocks) || value.blocks.length > 30) throw badRequest('Invalid page blocks');
  for (const block of value.blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw badRequest('Invalid page block');
    if ('gallery' in block && (block.type !== 'image' || typeof block.gallery !== 'string' || !block.gallery.length || block.gallery.length > 80)) throw badRequest('Invalid gallery');
    for (const [key, allowed] of Object.entries({ format: ['paragraph','heading','subheading','list'], width: ['full','narrow'], spacing: ['compact','normal','airy'] })) {
      if (key in block && !allowed.includes(block[key])) throw badRequest('Invalid block layout');
    }
    if (!block || !['text','image','video','button'].includes(block.type) || typeof block.id !== 'string' || block.id.length > 80
      || typeof block.text !== 'string' || block.text.length > 10000 || typeof block.url !== 'string' || block.url.length > 2000
      || typeof block.bold !== 'boolean' || typeof block.italic !== 'boolean' || !['start','center','end'].includes(block.align)) throw badRequest('Invalid page block');
    if (block.type === 'button' && block.url) throw badRequest('Order buttons cannot carry links');
    if (block.type !== 'text' && block.url) {
      let url; try { url = new URL(block.url); } catch { throw badRequest('Invalid media URL'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw badRequest('Invalid media URL');
      if (block.type === 'video' && !/\.(mp4|webm)$/i.test(url.pathname) && !['youtu.be','youtube.com','www.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(url.hostname)) throw badRequest('Unsupported video');
    }
  }
}