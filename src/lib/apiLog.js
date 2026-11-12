// Server (API) request log. requestLog.js hands every finished request here;
// rows are buffered in memory and written in batches so logging never slows a
// request. Query strings and bodies are never stored (they can hold customer
// data or tokens) — only method, path, status, timing and who/where from.
import { pool } from '../db.js';
import { createLogger } from './logger.js';
import { parseUserAgent, cleanIp, headerGeo, isBot } from './visitInfo.js';
import { geoLookup } from './geoip.js';

const log = createLogger('api-log');
const FLUSH_MS = 3000;
const MAX_BATCH = 500;
const MAX_BUFFER = 20_000;
const RETENTION_DAYS = Math.max(1, Number(process.env.API_LOG_RETENTION_DAYS) || 30);
const SKIP = /^\/(health|docs|favicon|domain-allowed)(\/|$)/i;

let buffer = [];
let timer = null;
let lastCleanup = 0;
let lastWarn = 0;

export const apiLogEnabled = () => process.env.API_REQUEST_LOG !== 'off';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Groups similar requests: ids and numbers become ":id"; storage object names are dropped. */
export function endpointOf(method, path) {
  let p = String(path || '/').split('?')[0].replace(UUID_RE, ':id').replace(/\/\d+(?=\/|$)/g, '/:id');
  const storage = /^\/storage\/v1\/(object(?:\/(?:public|sign|authenticated|info|list|move|copy))?)\/([^/]+)/.exec(p);
  if (storage) p = `/storage/v1/${storage[1]}/${storage[2]}/…`;
  return `${String(method || 'GET').toUpperCase()} ${p.slice(0, 160)}`;
}

/** Called once per finished request (see middleware/requestLog.js). */
export function recordApiRequest(req, res, ms) {
  if (!apiLogEnabled() || req.method === 'OPTIONS') return;
  const path = String(req.originalUrl || req.url || '/').split('?')[0];
  if (SKIP.test(path)) return;
  if (buffer.length >= MAX_BUFFER) return; // database unreachable for a while: drop rather than eat memory
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const { device, browser, os } = parseUserAgent(ua);
  let origin = null;
  try { origin = req.headers.origin ? new URL(String(req.headers.origin)).host.slice(0, 200) : null; } catch { origin = null; }
  buffer.push({
    created_at: new Date().toISOString(),
    req_id: req.id ? String(req.id).slice(0, 64) : null,
    method: String(req.method || 'GET').slice(0, 10),
    path: path.slice(0, 300),
    endpoint: endpointOf(req.method, path),
    status: res.statusCode || 0,
    ms: Math.max(0, Math.round(ms)),
    ip: cleanIp(req.ip),
    country: headerGeo(req.headers).country,
    user_id: req.ctx?.userId && /^[0-9a-f-]{36}$/i.test(req.ctx.userId) ? req.ctx.userId : null,
    role: req.ctx?.role ? String(req.ctx.role).slice(0, 30) : null,
    origin,
    browser: ua && !isBot(ua) ? browser : (ua ? 'Bot/script' : null),
    os, device,
    user_agent: ua || null,
    error: res.statusCode >= 400 && req.logError ? String(req.logError).slice(0, 300) : null,
  });
  if (buffer.length >= MAX_BATCH) void flushApiLog();
  else if (!timer) { timer = setTimeout(() => { timer = null; void flushApiLog(); }, FLUSH_MS); timer.unref?.(); }
}

const COLS = ['created_at', 'req_id', 'method', 'path', 'endpoint', 'status', 'ms', 'ip', 'country', 'user_id', 'role', 'origin', 'browser', 'os', 'device', 'user_agent', 'error'];
const TYPES = ['timestamptz', 'text', 'text', 'text', 'text', 'int', 'int', 'text', 'text', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text'];

/** Writes everything buffered so far. Exported for tests and graceful shutdown. */
export async function flushApiLog() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return 0;
  const rows = buffer.splice(0, MAX_BATCH);
  try {
    for (const r of rows) if (!r.country && r.ip) r.country = (await geoLookup(r.ip))?.country ?? null;
    await pool.query(
      `INSERT INTO public.api_request_logs (${COLS.join(', ')})
       SELECT * FROM unnest(${COLS.map((_, i) => `$${i + 1}::${TYPES[i]}[]`).join(', ')})`,
      COLS.map((c) => rows.map((r) => r[c])),
    );
    if (Date.now() - lastCleanup > 3_600_000) {
      lastCleanup = Date.now();
      pool.query(`DELETE FROM public.api_request_logs WHERE created_at < now() - make_interval(days => $1)`, [RETENTION_DAYS]).catch(() => {});
    }
  } catch (err) {
    if (Date.now() - lastWarn > 600_000) { lastWarn = Date.now(); log.warn('could not write request log', { message: err.message, dropped: rows.length }); }
    return 0;
  }
  if (buffer.length) void flushApiLog();
  return rows.length;
}
