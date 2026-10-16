// Email campaign blocks → safe, inline-styled HTML. Pure module shared by the server
// (sending) and the seller app (live preview) so both render identically.
export const BLOCK_TYPES = ['heading', 'text', 'button', 'image', 'product', 'divider', 'spacer'];
export const MAX_BLOCKS = 40;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function safeUrl(v) {
  const s = String(v || '').trim();
  if (/^mailto:[^\s<>"]+$/i.test(s)) return s;
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : ''; } catch { return ''; }
}
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : d);
const clip = (v, n) => String(v ?? '').slice(0, n);

/** Keeps only known block types and bounded, typed fields. */
export function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.slice(0, MAX_BLOCKS).filter((b) => b && BLOCK_TYPES.includes(b.type)).map((b) => {
    const align = ['left', 'center', 'right'].includes(b.align) ? b.align : 'left';
    switch (b.type) {
      case 'heading': return { type: 'heading', text: clip(b.text, 200), align };
      case 'text': return { type: 'text', text: clip(b.text, 4000), align };
      case 'button': return { type: 'button', label: clip(b.label, 80), url: safeUrl(b.url), align: b.align ? align : 'center' };
      case 'image': return { type: 'image', src: safeUrl(b.src), url: safeUrl(b.url), alt: clip(b.alt, 200) };
      case 'product': return { type: 'product', name: clip(b.name, 200), price: clip(b.price, 40), image: safeUrl(b.image), url: safeUrl(b.url), cta: clip(b.cta, 60) };
      case 'spacer': return { type: 'spacer', height: Math.min(80, Math.max(8, Number(b.height) || 24)) };
      default: return { type: 'divider' };
    }
  });
}

/** {prenom} / {nom} / {boutique} personalisation, applied to already-escaped text. */
function vars(text, r) {
  const parts = String(r.name || '').trim().split(/\s+/);
  const map = { prenom: parts[0] || '', nom: parts.slice(1).join(' ') || parts[0] || '', boutique: r.shopName || '' };
  return text.replace(/\{(prenom|nom|boutique)\}/g, (_, k) => esc(map[k]));
}

export function renderEmail({ blocks, preheader = '', accent, shopName = '', name = '', unsubscribeUrl = '' }) {
  const a = color(accent, '#15803d');
  const r = { name, shopName };
  const rows = sanitizeBlocks(blocks).map((b) => {
    const pad = 'padding:8px 32px;';
    if (b.type === 'heading') return `<tr><td style="${pad}text-align:${b.align}"><h1 style="margin:0;font-size:24px;line-height:1.3;color:#111827">${vars(esc(b.text), r)}</h1></td></tr>`;
    if (b.type === 'text') return `<tr><td style="${pad}text-align:${b.align};font-size:15px;line-height:1.6;color:#374151">${vars(esc(b.text), r).replace(/\n/g, '<br>')}</td></tr>`;
    if (b.type === 'button') return b.url ? `<tr><td style="padding:16px 32px;text-align:${b.align}"><a href="${esc(b.url)}" style="display:inline-block;background:${a};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;font-size:15px">${esc(b.label || 'Voir')}</a></td></tr>` : '';
    if (b.type === 'image') {
      if (!b.src) return '';
      const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px">`;
      return `<tr><td style="${pad}">${b.url ? `<a href="${esc(b.url)}">${img}</a>` : img}</td></tr>`;
    }
    if (b.type === 'product') {
      const img = b.image ? `<img src="${esc(b.image)}" alt="${esc(b.name)}" width="160" style="display:block;width:160px;height:160px;object-fit:cover;border-radius:8px;border:0">` : '';
      return `<tr><td style="${pad}"><table role="presentation" width="100%" style="border:1px solid #e5e7eb;border-radius:10px"><tr>
        <td style="padding:12px;width:160px">${b.url ? `<a href="${esc(b.url)}">${img}</a>` : img}</td>
        <td style="padding:12px;vertical-align:middle"><div style="font-size:16px;font-weight:600;color:#111827">${esc(b.name)}</div>
        <div style="font-size:15px;color:${a};font-weight:700;margin:6px 0 12px">${esc(b.price)}</div>
        ${b.url ? `<a href="${esc(b.url)}" style="display:inline-block;background:${a};color:#ffffff;text-decoration:none;font-weight:600;padding:9px 18px;border-radius:8px;font-size:14px">${esc(b.cta || 'Acheter')}</a>` : ''}</td></tr></table></td></tr>`;
    }
    if (b.type === 'spacer') return `<tr><td style="height:${b.height}px;line-height:${b.height}px">&nbsp;</td></tr>`;
    return `<tr><td style="${pad}"><hr style="border:0;border-top:1px solid #e5e7eb;margin:8px 0"></td></tr>`;
  }).join('');
  const foot = unsubscribeUrl ? `<a href="${esc(unsubscribeUrl)}" style="color:#6b7280">Se désabonner / Unsubscribe</a>` : 'Se désabonner / Unsubscribe';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px">
<tr><td style="padding:20px 32px;border-bottom:3px solid ${a};font-size:18px;font-weight:700;color:#111827">${esc(shopName)}</td></tr>
${rows}
<tr><td style="padding:24px 32px;font-size:12px;color:#6b7280;text-align:center">${esc(shopName)} · ${foot}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Plain-text version for mail clients that do not show HTML. */
export function renderText({ blocks, shopName = '', name = '', unsubscribeUrl = '' }) {
  const r = { name, shopName };
  const plain = (t) => vars(esc(t), r).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return sanitizeBlocks(blocks).map((b) => {
    if (b.type === 'heading' || b.type === 'text') return plain(b.text);
    if (b.type === 'button') return b.url ? `${b.label}: ${b.url}` : '';
    if (b.type === 'product') return `${b.name} — ${b.price}${b.url ? `\n${b.url}` : ''}`;
    if (b.type === 'image') return b.url || '';
    return '';
  }).filter(Boolean).join('\n\n') + (unsubscribeUrl ? `\n\n—\nSe désabonner: ${unsubscribeUrl}` : '');
}
