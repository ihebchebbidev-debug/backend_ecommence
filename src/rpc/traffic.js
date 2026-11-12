// Platform traffic counter. Visitors' browsers report page views through
// track_site_visit (public); only super admins read them back, because rows
// hold IP addresses. The IP comes from the trusted-proxy address, never the client.
import { forbidden } from '../lib/errors.js';
import { isBot, parseUserAgent, parseUserAgentDetails, cleanVisitMeta, visitArea, referrerHost, cleanIp, headerGeo } from '../lib/visitInfo.js';
import { geoLookup } from '../lib/geoip.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('traffic');

const RETENTION_DAYS = 400;
const AREAS = new Set(['platform', 'seller_app', 'storefront']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recent = new Map(); // session|path → ms, to drop double reports
const perIp = new Map();  // ip → { n, since }
const slugCache = new Map(); // slug|host → store id (or null), 10 min

function rateLimited(ip, now) {
  if (!ip) return false;
  const e = perIp.get(ip);
  if (!e || now - e.since > 10 * 60_000) { perIp.set(ip, { n: 1, since: now }); return false; }
  e.n += 1;
  return e.n > 600;
}

function sweep(now) {
  if (recent.size > 20_000) for (const [k, t] of recent) if (now - t > 10_000) recent.delete(k);
  if (perIp.size > 20_000) for (const [k, e] of perIp) if (now - e.since > 10 * 60_000) perIp.delete(k);
  if (slugCache.size > 5_000) slugCache.clear();
}

async function storeFor(ctx, slug, host) {
  const key = `${slug || ''}|${host || ''}`;
  const hit = slugCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
  let id = null;
  if (slug) {
    id = (await ctx.q('SELECT id FROM public.platform_stores WHERE lower(slug) = $1 AND deleted_at IS NULL LIMIT 1', [slug]))[0]?.id ?? null;
  } else if (host) {
    id = (await ctx.q(
      `SELECT s.id FROM public.platform_stores s
        WHERE lower(s.store_domain) = $1 AND s.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM public.store_domain_requests r WHERE r.store_id = s.id AND lower(r.domain) = $1 AND r.status = 'active')
        LIMIT 1`, [host])).at(0)?.id ?? null;
  }
  slugCache.set(key, { id, at: Date.now() });
  return id;
}

async function requireSuperAdmin(ctx) {
  ctx.requireAuth();
  if (!(await ctx.isSuperAdmin())) throw forbidden('Super admin access required');
}

const DAY = 86_400_000;
/** Validated [from, to) window; defaults to the last 30 days, capped at 400 days. */
export function trafficWindow(p_from, p_to, now = Date.now()) {
  const to = p_to && !Number.isNaN(Date.parse(p_to)) ? new Date(p_to) : new Date(now);
  let from = p_from && !Number.isNaN(Date.parse(p_from)) ? new Date(p_from) : new Date(to.getTime() - 30 * DAY);
  if (from >= to) from = new Date(to.getTime() - DAY);
  if (to.getTime() - from.getTime() > RETENTION_DAYS * DAY) from = new Date(to.getTime() - RETENTION_DAYS * DAY);
  return { from: from.toISOString(), to: to.toISOString(), hourly: to.getTime() - from.getTime() <= 2 * DAY };
}

/** Shared WHERE clause for the admin filters; returns [sql, params]. */
function filters({ p_from, p_to, p_area, p_country, p_store_id, p_search, p_device }) {
  const w = trafficWindow(p_from, p_to);
  const where = ['created_at >= $1', 'created_at < $2'];
  const params = [w.from, w.to];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (p_area && AREAS.has(p_area)) add('area = ?', p_area);
  if (p_country && /^[A-Z]{2}$|^unknown$/i.test(p_country)) {
    if (p_country === 'unknown') where.push('country IS NULL'); else add('country = ?', String(p_country).toUpperCase());
  }
  if (p_store_id && /^[0-9a-f-]{36}$/i.test(p_store_id)) add('store_id = ?::uuid', p_store_id);
  if (p_device && ['mobile', 'tablet', 'desktop'].includes(p_device)) add('device = ?', p_device);
  if (p_search && String(p_search).trim()) {
    params.push(`%${String(p_search).trim().slice(0, 100).replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    const i = params.length;
    where.push(`(ip ILIKE $${i} OR path ILIKE $${i} OR coalesce(city,'') ILIKE $${i} OR coalesce(referrer_host,'') ILIKE $${i} OR coalesce(session_id,'') ILIKE $${i} OR coalesce(visitor_id,'') ILIKE $${i} OR coalesce(utm_campaign,'') ILIKE $${i} OR coalesce(utm_source,'') ILIKE $${i} OR coalesce(device_model,'') ILIKE $${i})`);
  }
  return { sql: where.join(' AND '), params, window: w };
}

/** WHERE clause for the server request log filters; returns [sql, params]. */
function apiFilters({ p_from, p_to, p_status, p_method, p_search, p_country, p_role }) {
  const w = trafficWindow(p_from, p_to);
  const where = ['created_at >= $1', 'created_at < $2'];
  const params = [w.from, w.to];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (/^[2-5]xx$/.test(String(p_status || ''))) { const b = Number(String(p_status)[0]) * 100; where.push(`status >= ${b} AND status < ${b + 100}`); }
  else if (p_status === 'errors') where.push('status >= 400');
  if (p_method && /^(GET|POST|PATCH|PUT|DELETE|HEAD)$/.test(p_method)) add('method = ?', p_method);
  if (p_role && /^(anon|authenticated|service_role)$/.test(p_role)) add("coalesce(role, 'anon') = ?", p_role);
  if (p_country && /^[A-Z]{2}$/i.test(p_country)) add('country = ?', String(p_country).toUpperCase());
  if (p_search && String(p_search).trim()) {
    params.push(`%${String(p_search).trim().slice(0, 100).replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    const i = params.length;
    where.push(`(coalesce(ip,'') ILIKE $${i} OR path ILIKE $${i} OR endpoint ILIKE $${i} OR coalesce(req_id,'') ILIKE $${i} OR coalesce(origin,'') ILIKE $${i} OR coalesce(user_id::text,'') ILIKE $${i})`);
  }
  return { sql: where.join(' AND '), params, window: w };
}

export default {
  /** track_site_visit(p_path, p_referrer, p_session_id, p_lang, p_host, p_meta) → { ok, id } — public page-view report. */
  async track_site_visit({ p_path, p_referrer, p_session_id, p_lang, p_host, p_meta } = {}, ctx) {
    const path = String(p_path || '').slice(0, 500);
    if (!path.startsWith('/')) return { ok: false };
    const headers = ctx.requestHeaders || {};
    const ua = String(headers['user-agent'] || '').slice(0, 400);
    if (isBot(ua)) return { ok: false, reason: 'bot' };
    const { area: pathArea, slug } = visitArea(path);
    if (pathArea === 'ignored') return { ok: false, reason: 'ignored' };
    const ip = cleanIp(ctx.requestIp);
    const now = Date.now();
    sweep(now);
    if (rateLimited(ip, now)) return { ok: false, reason: 'rate' };
    const session = p_session_id && /^[A-Za-z0-9-]{8,64}$/.test(String(p_session_id)) ? String(p_session_id) : null;
    const dedupeKey = `${session || ip}|${path}`;
    if (now - (recent.get(dedupeKey) || 0) < 5_000) return { ok: true, duplicate: true };
    recent.set(dedupeKey, now);

    const host = String(p_host || headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '').slice(0, 200) || null;
    // A custom shop domain serves the shop at its root, so the host identifies the store.
    let area = pathArea;
    let storeId = null;
    try {
      storeId = await storeFor(ctx, slug, slug ? null : host);
      if (!slug && storeId) area = 'storefront';
    } catch { storeId = null; }
    const geo = headerGeo(headers);
    const { device, browser, os } = parseUserAgent(ua);
    const lang = p_lang && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(String(p_lang)) ? String(p_lang) : null;
    const ref = p_referrer ? String(p_referrer).slice(0, 500) : null;
    const meta = cleanVisitMeta(p_meta);
    const ud = parseUserAgentDetails(ua);
    const rows = await ctx.q(
      `INSERT INTO public.site_visits (session_id, ip, country, city, path, host, referrer, referrer_host, area, store_id, user_id, device, browser, os, lang, user_agent,
                                       visitor_id, is_new_visitor, page_title, utm_source, utm_medium, utm_campaign, click_id, screen, viewport, pixel_ratio,
                                       browser_tz, languages, connection, browser_version, os_version, device_model, load_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17::text,
               CASE WHEN $17::text IS NULL THEN NULL ELSE NOT EXISTS (
                 SELECT 1 FROM public.site_visits o WHERE o.visitor_id = $17::text AND o.session_id IS DISTINCT FROM $1::text) END,
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id`,
      [session, ip, geo.country, geo.city, path, host, ref, referrerHost(ref, host), area, storeId, ctx.userId || null, device, browser, os, lang, ua || null,
        meta.visitor_id, meta.page_title, meta.utm_source, meta.utm_medium, meta.utm_campaign, meta.click_id, meta.screen, meta.viewport, meta.pixel_ratio,
        meta.browser_tz, meta.languages, meta.connection, ud.browserVersion, ud.osVersion, meta.device_model || ud.model, meta.load_ms],
    );
    const id = rows[0]?.id;
    // Country lookup and old-row cleanup never delay the visitor.
    if (id && !geo.country && ip) {
      geoLookup(ip).then((g) => g && ctx.q(
        'UPDATE public.site_visits SET country = $2, region = $3, city = coalesce(city, $4), timezone = $5 WHERE id = $1',
        [id, g.country, g.region, g.city, g.timezone],
      )).catch(() => {});
    }
    if (Math.random() < 0.002) {
      ctx.q(`DELETE FROM public.site_visits WHERE created_at < now() - interval '${RETENTION_DAYS} days'`).catch(() => {});
    }
    log.info('visit', { id, ip, country: geo.country || undefined, area, path, storeId: storeId || undefined, device, browser, session: session || undefined });
    return { ok: true, id };
  },

  /** track_visit_end(p_visit_id, p_session_id, p_duration_ms, p_scroll_pct) → { ok } — time spent and scroll depth for a page view. */
  async track_visit_end({ p_visit_id, p_session_id, p_duration_ms, p_scroll_pct } = {}, ctx) {
    if (!UUID.test(String(p_visit_id || '')) || !/^[A-Za-z0-9-]{8,64}$/.test(String(p_session_id || ''))) return { ok: false };
    const ip = cleanIp(ctx.requestIp);
    if (rateLimited(ip, Date.now())) return { ok: false, reason: 'rate' };
    const ms = Math.round(Number(p_duration_ms));
    const scroll = Math.round(Number(p_scroll_pct));
    const duration = Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 6 * 3_600_000) : null;
    const depth = Number.isFinite(scroll) && scroll >= 0 ? Math.min(scroll, 100) : null;
    if (duration === null && depth === null) return { ok: false };
    const rows = await ctx.q(
      `UPDATE public.site_visits
          SET duration_ms = GREATEST(coalesce(duration_ms, 0), coalesce($3::int, 0)),
              scroll_pct  = GREATEST(coalesce(scroll_pct, 0), coalesce($4::int, 0))
        WHERE id = $1::uuid AND session_id = $2 AND created_at > now() - interval '12 hours'
        RETURNING id`,
      [p_visit_id, String(p_session_id), duration, depth],
    );
    return { ok: rows.length > 0 };
  },

  /** admin_traffic_summary(filters) → counters, time series and top lists. Super admin only. */
  async admin_traffic_summary(args = {}, ctx) {
    await requireSuperAdmin(ctx);
    const { sql, params, window } = filters(args);
    const bucket = window.hourly ? 'hour' : 'day';
    const q = (s) => ctx.q(s, params);
    const [totals, series, countries, pages, referrers, devices, browsers, oses, stores, areas, live, today,
      engagement, entries, campaigns, cities, screens, langs, models] = await Promise.all([
      q(`SELECT count(*)::int AS visits, count(DISTINCT coalesce(session_id, ip))::int AS visitors,
                count(DISTINCT ip)::int AS unique_ips, count(DISTINCT country)::int AS countries
           FROM public.site_visits WHERE ${sql}`),
      q(`SELECT date_trunc('${bucket}', created_at) AS t, count(*)::int AS visits, count(DISTINCT coalesce(session_id, ip))::int AS visitors
           FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 1`),
      q(`SELECT coalesce(country, 'unknown') AS key, count(*)::int AS visits, count(DISTINCT coalesce(session_id, ip))::int AS visitors
           FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
      q(`SELECT path AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
      q(`SELECT coalesce(referrer_host, 'direct') AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT coalesce(device, 'desktop') AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT coalesce(browser, 'Autre') AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT coalesce(os, 'Autre') AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT v.store_id AS id, coalesce(s.store_name, '—') AS key, count(*)::int AS visits
           FROM public.site_visits v LEFT JOIN public.platform_stores s ON s.id = v.store_id
          WHERE ${sql.replace(/\b(created_at|area|country|store_id|device|ip|path|city|referrer_host|session_id|visitor_id|utm_campaign|utm_source|device_model)\b/g, 'v.$1')} AND v.store_id IS NOT NULL
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`),
      q(`SELECT area AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC`),
      ctx.q(`SELECT count(DISTINCT coalesce(session_id, ip))::int AS n FROM public.site_visits WHERE created_at > now() - interval '5 minutes'`),
      ctx.q(`SELECT count(*)::int AS visits, count(DISTINCT coalesce(session_id, ip))::int AS visitors FROM public.site_visits WHERE created_at >= date_trunc('day', now())`),
      q(`WITH s AS (SELECT coalesce(session_id, ip) AS k, count(*) AS pages, sum(coalesce(duration_ms, 0)) AS ms
                      FROM public.site_visits WHERE ${sql} GROUP BY 1)
         SELECT (SELECT count(*)::int FROM s) AS sessions,
                (SELECT count(*)::int FROM s WHERE pages = 1) AS bounces,
                (SELECT round(avg(ms))::int FROM s WHERE ms > 0) AS avg_session_ms,
                (SELECT round(avg(duration_ms))::int FROM public.site_visits WHERE ${sql} AND duration_ms > 0) AS avg_page_ms,
                (SELECT round(avg(scroll_pct))::int FROM public.site_visits WHERE ${sql} AND scroll_pct IS NOT NULL) AS avg_scroll,
                (SELECT count(DISTINCT visitor_id)::int FROM public.site_visits WHERE ${sql} AND is_new_visitor) AS new_visitors,
                (SELECT count(DISTINCT visitor_id)::int FROM public.site_visits WHERE ${sql} AND is_new_visitor = false) AS returning_visitors,
                (SELECT round(avg(load_ms))::int FROM public.site_visits WHERE ${sql} AND load_ms > 0) AS avg_load_ms`),
      q(`SELECT path AS key, count(*)::int AS visits FROM (
           SELECT DISTINCT ON (coalesce(session_id, ip)) path FROM public.site_visits WHERE ${sql} ORDER BY coalesce(session_id, ip), created_at) e
          GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT concat_ws(' · ', coalesce(utm_source, CASE click_id WHEN 'fbclid' THEN 'facebook (pub)' WHEN 'gclid' THEN 'google (pub)' WHEN 'wbraid' THEN 'google (pub)' WHEN 'gbraid' THEN 'google (pub)'
                                   WHEN 'ttclid' THEN 'tiktok (pub)' WHEN 'msclkid' THEN 'bing (pub)' END), utm_medium, utm_campaign) AS key, count(*)::int AS visits
           FROM public.site_visits WHERE ${sql} AND (utm_source IS NOT NULL OR click_id IS NOT NULL) GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT concat_ws(' · ', city, country) AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} AND city IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT screen AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} AND screen IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT lang AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} AND lang IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT device_model AS key, count(*)::int AS visits FROM public.site_visits WHERE ${sql} AND device_model IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    ]);
    return {
      window: { from: window.from, to: window.to, bucket },
      totals: totals[0],
      live_now: live[0]?.n ?? 0,
      today: today[0] ?? { visits: 0, visitors: 0 },
      series, countries, pages, referrers, devices, browsers, os: oses, stores, areas,
      engagement: engagement[0] ?? {}, entries, campaigns, cities, screens, langs, models,
    };
  },

  /** admin_traffic_visits(filters, p_limit, p_offset) → { total, rows } of individual page views. Super admin only. */
  async admin_traffic_visits(args = {}, ctx) {
    await requireSuperAdmin(ctx);
    const { sql, params } = filters(args);
    const limit = Math.min(200, Math.max(1, Number(args.p_limit) || 50));
    const offset = Math.max(0, Math.min(100_000, Number(args.p_offset) || 0));
    const v = sql.replace(/\b(created_at|area|country|store_id|device|ip|path|city|referrer_host|session_id|visitor_id|utm_campaign|utm_source|device_model)\b/g, 'v.$1');
    const [count, rows] = await Promise.all([
      ctx.q(`SELECT count(*)::int AS n FROM public.site_visits v WHERE ${v}`, params),
      ctx.q(`SELECT v.id, v.created_at, v.ip, v.country, v.region, v.city, v.timezone, v.path, v.host, v.referrer, v.referrer_host,
                    v.area, v.store_id, s.store_name, v.device, v.browser, v.os, v.lang, v.session_id, v.user_id, p.email AS user_email,
                    v.visitor_id, v.is_new_visitor, v.page_title, v.utm_source, v.utm_medium, v.utm_campaign, v.click_id, v.screen, v.viewport,
                    v.pixel_ratio, v.browser_tz, v.languages, v.connection, v.browser_version, v.os_version, v.device_model, v.load_ms,
                    v.duration_ms, v.scroll_pct
               FROM public.site_visits v
               LEFT JOIN public.platform_stores s ON s.id = v.store_id
               LEFT JOIN public.profiles p ON p.id = v.user_id
              WHERE ${v} ORDER BY v.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return { total: count[0]?.n ?? 0, rows };
  },

  /** admin_traffic_visit(p_id) → { visit, journey, visitor } — one page view with its session path and the visitor's history. Super admin only. */
  async admin_traffic_visit({ p_id } = {}, ctx) {
    await requireSuperAdmin(ctx);
    if (!UUID.test(String(p_id || ''))) return null;
    const [visit] = await ctx.q(
      `SELECT v.*, s.store_name, p.email AS user_email FROM public.site_visits v
         LEFT JOIN public.platform_stores s ON s.id = v.store_id
         LEFT JOIN public.profiles p ON p.id = v.user_id
        WHERE v.id = $1::uuid`, [p_id]);
    if (!visit) return null;
    const journey = visit.session_id ? await ctx.q(
      `SELECT id, created_at, path, page_title, duration_ms, scroll_pct FROM public.site_visits
        WHERE session_id = $1 ORDER BY created_at LIMIT 100`, [visit.session_id]) : [];
    // A visitor is known by the browser's long-lived id; without it, by IP address.
    const [col, key] = visit.visitor_id ? ['visitor_id', visit.visitor_id] : ['ip', visit.ip];
    let visitor = null;
    if (key) {
      const [agg] = await ctx.q(
        `SELECT min(created_at) AS first_seen, max(created_at) AS last_seen, count(*)::int AS visits,
                count(DISTINCT session_id)::int AS sessions, coalesce(sum(duration_ms), 0)::bigint AS total_ms,
                (array_agg(DISTINCT ip) FILTER (WHERE ip IS NOT NULL))[1:10] AS ips,
                (array_agg(DISTINCT country) FILTER (WHERE country IS NOT NULL))[1:10] AS countries,
                (array_agg(DISTINCT store_id::text) FILTER (WHERE store_id IS NOT NULL))[1:20] AS store_ids
           FROM public.site_visits WHERE ${col} = $1`, [key]);
      const sessions = await ctx.q(
        `SELECT session_id, min(created_at) AS started_at, count(*)::int AS pages, coalesce(sum(duration_ms), 0)::bigint AS ms,
                (array_agg(path ORDER BY created_at))[1] AS entry, (array_agg(referrer_host ORDER BY created_at))[1] AS referrer_host
           FROM public.site_visits WHERE ${col} = $1 AND session_id IS NOT NULL
          GROUP BY session_id ORDER BY 2 DESC LIMIT 10`, [key]);
      visitor = { by: col, ...agg, total_ms: Number(agg?.total_ms || 0), sessions_list: sessions.map((x) => ({ ...x, ms: Number(x.ms || 0) })) };
    }
    return { visit, journey, visitor };
  },

  /** admin_api_summary(filters) → server request counters, timings, errors and top lists. Super admin only. */
  async admin_api_summary(args = {}, ctx) {
    await requireSuperAdmin(ctx);
    const { sql, params, window } = apiFilters(args);
    const bucket = window.hourly ? 'hour' : 'day';
    const q = (s) => ctx.q(s, params);
    const T = 'public.api_request_logs';
    const [totals, series, endpoints, statuses, ips, countries, roles, origins, slow, live] = await Promise.all([
      q(`SELECT count(*)::int AS requests, count(*) FILTER (WHERE status >= 500)::int AS errors,
                count(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS rejected,
                coalesce(round(avg(ms)), 0)::int AS avg_ms,
                coalesce(round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)), 0)::int AS p95_ms,
                count(DISTINCT ip)::int AS unique_ips, count(DISTINCT user_id)::int AS users
           FROM ${T} WHERE ${sql}`),
      q(`SELECT date_trunc('${bucket}', created_at) AS t, count(*)::int AS visits, count(*) FILTER (WHERE status >= 500)::int AS errors
           FROM ${T} WHERE ${sql} GROUP BY 1 ORDER BY 1`),
      q(`SELECT endpoint AS key, count(*)::int AS visits, round(avg(ms))::int AS avg_ms,
                count(*) FILTER (WHERE status >= 400)::int AS errors
           FROM ${T} WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
      q(`SELECT status::text AS key, count(*)::int AS visits FROM ${T} WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
      q(`SELECT ip AS key, max(country) AS country, count(*)::int AS visits, count(*) FILTER (WHERE status >= 400)::int AS errors
           FROM ${T} WHERE ${sql} AND ip IS NOT NULL GROUP BY 1 ORDER BY 3 DESC LIMIT 15`),
      q(`SELECT coalesce(country, 'unknown') AS key, count(*)::int AS visits FROM ${T} WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
      q(`SELECT coalesce(role, 'anon') AS key, count(*)::int AS visits FROM ${T} WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT coalesce(origin, '—') AS key, count(*)::int AS visits FROM ${T} WHERE ${sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT endpoint AS key, round(avg(ms))::int AS visits, count(*)::int AS calls FROM ${T} WHERE ${sql}
          GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 10`),
      ctx.q(`SELECT count(*)::int AS n FROM ${T} WHERE created_at > now() - interval '1 minute'`),
    ]);
    return { window: { from: window.from, to: window.to, bucket }, totals: totals[0], live_per_minute: live[0]?.n ?? 0,
      series, endpoints, statuses, ips, countries, roles, origins, slow };
  },

  /** admin_api_requests(filters, p_limit, p_offset) → { total, rows } of individual server requests. Super admin only. */
  async admin_api_requests(args = {}, ctx) {
    await requireSuperAdmin(ctx);
    const { sql, params } = apiFilters(args);
    const limit = Math.min(200, Math.max(1, Number(args.p_limit) || 50));
    const offset = Math.max(0, Math.min(100_000, Number(args.p_offset) || 0));
    const v = sql.replace(/\b(created_at|status|method|endpoint|path|ip|country|role|req_id|origin|user_id)\b/g, 'l.$1');
    const [count, rows] = await Promise.all([
      ctx.q(`SELECT count(*)::int AS n FROM public.api_request_logs l WHERE ${v}`, params),
      ctx.q(`SELECT l.id::text AS id, l.created_at, l.req_id, l.method, l.path, l.endpoint, l.status, l.ms, l.ip, l.country, l.user_id,
                    p.email AS user_email, l.role, l.origin, l.browser, l.os, l.device, l.user_agent, l.error
               FROM public.api_request_logs l LEFT JOIN public.profiles p ON p.id = l.user_id
              WHERE ${v} ORDER BY l.created_at DESC, l.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return { total: count[0]?.n ?? 0, rows };
  },
};
