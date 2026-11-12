// Offline IP → country lookup (fast-geoip reads its bundled database from disk,
// so no visitor address is sent to a third party). Results are cached in memory.
import { isPrivateIp } from './visitInfo.js';

let lookupFn;
const cache = new Map();
const MAX = 5000;

async function loader() {
  if (lookupFn !== undefined) return lookupFn;
  try {
    const mod = await import('fast-geoip');
    const g = mod.default || mod;
    lookupFn = typeof g.lookup === 'function' ? g.lookup.bind(g) : null;
  } catch { lookupFn = null; }
  return lookupFn;
}

export async function geoLookup(ip) {
  if (!ip || isPrivateIp(ip) || process.env.TRAFFIC_GEO_LOOKUP === 'off') return null;
  if (cache.has(ip)) return cache.get(ip);
  const fn = await loader();
  let out = null;
  if (fn) {
    try {
      const r = await fn(ip);
      if (r?.country) out = { country: String(r.country).toUpperCase(), region: r.region || null, city: r.city || null, timezone: r.timezone || null };
    } catch { out = null; }
  }
  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(ip, out);
  return out;
}
