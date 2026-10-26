import { badRequest } from './errors.js';
export function validateLandingContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Invalid sales content');
  for (const key of ['quick_order','capture_abandoned']) if (key in value && typeof value[key] !== 'boolean') throw badRequest('Invalid checkout setting');
  if (value.blocks == null) return;
  if (!Array.isArray(value.blocks) || value.blocks.length > 30) throw badRequest('Invalid page blocks');
  for (const block of value.blocks) {
    for (const [key, allowed] of Object.entries({ format: ['paragraph','heading','subheading','list'], width: ['full','narrow'], spacing: ['compact','normal','airy'] })) {
      if (key in block && !allowed.includes(block[key])) throw badRequest('Invalid block layout');
    }
    if (!block || !['text','image','video'].includes(block.type) || typeof block.id !== 'string' || block.id.length > 80
      || typeof block.text !== 'string' || block.text.length > 10000 || typeof block.url !== 'string' || block.url.length > 2000
      || typeof block.bold !== 'boolean' || typeof block.italic !== 'boolean' || !['start','center','end'].includes(block.align)) throw badRequest('Invalid page block');
    if (block.type !== 'text' && block.url) {
      let url; try { url = new URL(block.url); } catch { throw badRequest('Invalid media URL'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw badRequest('Invalid media URL');
      if (block.type === 'video' && !/\.(mp4|webm)$/i.test(url.pathname) && !['youtu.be','youtube.com','www.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(url.hostname)) throw badRequest('Unsupported video');
    }
  }
}