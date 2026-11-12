// Pure helpers for the traffic counter: browser/device parsing, visit area and
// referrer host. Kept free of I/O so they are unit-testable.

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch/i;

export function isBot(ua) {
  return !ua || BOT_RE.test(String(ua));
}

export function parseUserAgent(ua) {
  const s = String(ua || '');
  const device = /ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(s) ? 'tablet'
    : /mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(s) ? 'mobile' : 'desktop';
  const os = /windows nt/i.test(s) ? 'Windows'
    : /iphone|ipad|ipod/i.test(s) ? 'iOS'
    : /android/i.test(s) ? 'Android'
    : /mac os x|macintosh/i.test(s) ? 'macOS'
    : /cros/i.test(s) ? 'ChromeOS'
    : /linux/i.test(s) ? 'Linux' : 'Autre';
  const browser = /edg\//i.test(s) ? 'Edge'
    : /opr\/|opera/i.test(s) ? 'Opera'
    : /samsungbrowser/i.test(s) ? 'Samsung Internet'
    : /fban|fbav|instagram/i.test(s) ? 'Facebook/Instagram'
    : /firefox|fxios/i.test(s) ? 'Firefox'
    : /chrome|crios/i.test(s) ? 'Chrome'
    : /safari/i.test(s) ? 'Safari' : 'Autre';
  return { device, os, browser };
}

/** Browser/OS version and phone model, when the user agent tells them. */
export function parseUserAgentDetails(ua) {
  const s = String(ua || '');
  const m = (re) => re.exec(s)?.[1] ?? null;
  const browserVersion = m(/edg\/([\d.]+)/i) || m(/opr\/([\d.]+)/i) || m(/samsungbrowser\/([\d.]+)/i)
    || m(/(?:firefox|fxios)\/([\d.]+)/i) || m(/(?:chrome|crios)\/([\d.]+)/i) || m(/version\/([\d.]+).*safari/i);
  const win = m(/windows nt ([\d.]+)/i);
  const osVersion = win ? ({ '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[win] || win)
    : (m(/(?:iphone|cpu) os (\d+(?:_\d+)*)/i) || m(/android ([\d.]+)/i) || m(/mac os x (\d+(?:[_.]\d+)*)/i) || '').replace(/_/g, '.') || null;
  let model = m(/android [\d.]+; ([^;)]+?)(?: build\/[^;)]*)?\)/i);
  if (model && (/^(k|wv|linux|mobile|tablet)$/i.test(model.trim()) || model.length > 60)) model = null;
  if (!model) model = /iphone/i.test(s) ? 'iPhone' : /ipad/i.test(s) ? 'iPad' : null;
  return {
    browserVersion: browserVersion ? browserVersion.split('.').slice(0, 2).join('.') : null,
    osVersion: osVersion ? osVersion.slice(0, 20) : null,
    model: model ? model.trim().slice(0, 60) : null,
  };
}

/** Allow-listed page details sent by the visitor's browser (src/lib/visitTracker.ts). */
export function cleanVisitMeta(meta) {
  const o = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const str = (v, max, re) => { if (v === null || v === undefined) return null; const t = String(v).trim().slice(0, max); return t && (!re || re.test(t)) ? t : null; };
  const int = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const num = Number(o.dpr);
  return {
    visitor_id: str(o.visitor_id, 64, /^[A-Za-z0-9-]{8,64}$/),
    page_title: str(o.title, 200),
    utm_source: str(o.utm_source, 100),
    utm_medium: str(o.utm_medium, 100),
    utm_campaign: str(o.utm_campaign, 150),
    click_id: str(o.click_id, 20, /^(fbclid|gclid|ttclid|msclkid|wbraid|gbraid)$/),
    screen: str(o.screen, 20, /^\d{2,5}x\d{2,5}$/),
    viewport: str(o.viewport, 20, /^\d{2,5}x\d{2,5}$/),
    pixel_ratio: Number.isFinite(num) && num > 0 && num <= 8 ? Math.round(num * 100) / 100 : null,
    browser_tz: str(o.tz, 60, /^[A-Za-z_+\-/0-9]+$/),
    languages: str(o.languages, 120, /^[A-Za-z, -]+$/),
    connection: str(o.connection, 20, /^(slow-2g|2g|3g|4g|5g|wifi|ethernet|cellular)$/),
    device_model: str(o.model, 60, /^[\w .()+-]+$/),
    load_ms: int(o.load_ms, 0, 120_000),
  };
}

const STORE_PATH_RE = /^\/(?:(?:ar|fr|en)\/)?(?:store|s)\/([a-z0-9][a-z0-9-]{0,80})(?:[/?#]|$)/i;

/** Which part of the product a path belongs to; storefront paths also yield the shop slug. */
export function visitArea(path) {
  const p = String(path || '/');
  if (/^\/(admin|mobile-preview)(\/|$)/i.test(p)) return { area: 'ignored', slug: null };
  const m = STORE_PATH_RE.exec(p);
  if (m) return { area: 'storefront', slug: m[1].toLowerCase() };
  if (/^\/(app|team|agent|onboarding)(\/|$)/i.test(p)) return { area: 'seller_app', slug: null };
  return { area: 'platform', slug: null };
}

export function referrerHost(ref, ownHost) {
  if (!ref) return null;
  try {
    const h = new URL(String(ref)).hostname.toLowerCase().replace(/^www\./, '');
    const own = String(ownHost || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    return h && h !== own ? h.slice(0, 200) : null;
  } catch { return null; }
}

export function cleanIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '').trim();
  return s ? s.slice(0, 64) : null;
}

/** Private, loopback and link-local addresses have no country. */
export function isPrivateIp(ip) {
  const s = String(ip || '');
  return !s || s === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80)/i.test(s);
}

/** Country from a trusted edge proxy header (Cloudflare, Vercel, CloudFront, nginx geoip). */
export function headerGeo(headers = {}) {
  const pick = (...names) => { for (const n of names) { const v = headers[n]; if (v && String(v).trim()) return String(v).trim(); } return null; };
  const country = pick('cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code', 'x-geo-country');
  const city = pick('cf-ipcity', 'x-vercel-ip-city', 'cloudfront-viewer-city', 'x-geo-city');
  const valid = country && /^[A-Z]{2}$/i.test(country) && !/^(XX|T1)$/i.test(country);
  return { country: valid ? country.toUpperCase() : null, city: city ? decodeURIComponent(city).slice(0, 120) : null };
}
