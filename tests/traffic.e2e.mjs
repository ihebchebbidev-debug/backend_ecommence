// Traffic counter: public page-view reports and super-admin-only readback.
//   DATABASE_URL=postgres://... node --test tests/traffic.e2e.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  test('traffic e2e (skipped: set DATABASE_URL to a disposable database)', { skip: true }, () => {});
} else {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'e2e-service-role-secret';
  process.env.TRAFFIC_GEO_LOOKUP = 'off';
  const { server, bootstrap } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const { signApiKey } = await import('../src/lib/jwt.js');
  const { flushApiLog } = await import('../src/lib/apiLog.js');
  const ANON = signApiKey('anon');
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  let base, adminToken, userToken, slug;
  const sql = (q, p) => pool.query(q, p).then((r) => r.rows);
  async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
    const res = await fetch(base + path, { method, headers: { apikey: ANON, authorization: `Bearer ${token || ANON}`, 'user-agent': UA, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  const rpc = (name, args, opts = {}) => call(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, ...opts });
  async function account(tag) {
    const email = `${tag}+${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
    await call('/auth/v1/signup', { method: 'POST', body: { email, password: 'secret123', data: { full_name: tag } } });
    const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'secret123' } });
    return { token: login.body.access_token, id: login.body.user.id };
  }
  const session = () => `sess-${Math.random().toString(36).slice(2, 12)}`;

  before(async () => {
    await bootstrap({ force: true });
    base = await new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));
    const admin = await account('trafficadmin');
    await sql("INSERT INTO public.admin_roles (user_id, role) VALUES ($1, 'super_admin') ON CONFLICT DO NOTHING", [admin.id]);
    adminToken = admin.token;
    const user = await account('trafficuser');
    userToken = user.token;
    const st = await rpc('create_initial_store_for_user', { p_input: { store_name: `Traffic ${Date.now()}`, selected_plan: 'starter' } }, { token: userToken });
    slug = (Array.isArray(st.body) ? st.body[0] : st.body).created_store_slug;
    await sql('DELETE FROM public.site_visits');
  });
  after(async () => {
    await flushApiLog();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  test('a page view records path, country from the edge header, device and shop', async () => {
    const s = session();
    const r = await rpc('track_site_visit', { p_path: `/ar/s/${slug}`, p_referrer: 'https://www.facebook.com/ads', p_session_id: s, p_lang: 'ar', p_host: 'e-commence.shop' }, { headers: { 'cf-ipcountry': 'TN', 'x-forwarded-for': '41.226.11.1' } });
    assert.equal(r.body.ok, true);
    const [row] = await sql('SELECT * FROM public.site_visits WHERE session_id = $1', [s]);
    assert.equal(row.country, 'TN');
    assert.equal(row.area, 'storefront');
    assert.ok(row.store_id, 'shop resolved from the path');
    assert.equal(row.device, 'mobile');
    assert.equal(row.referrer_host, 'facebook.com');
    assert.ok(row.ip, 'ip recorded from the request, not the client');
  });

  test('bots, admin pages and repeated reports are not counted', async () => {
    const s = session();
    await rpc('track_site_visit', { p_path: '/', p_session_id: s }, { headers: { 'user-agent': 'Googlebot/2.1' } });
    await rpc('track_site_visit', { p_path: '/admin/dashboard', p_session_id: s });
    await rpc('track_site_visit', { p_path: '/pricing', p_session_id: s });
    await rpc('track_site_visit', { p_path: '/pricing', p_session_id: s });
    const rows = await sql('SELECT path FROM public.site_visits WHERE session_id = $1', [s]);
    assert.deepEqual(rows.map((r) => r.path), ['/pricing']);
  });

  test('only super admins can read traffic, and never over REST', async () => {
    const denied = await rpc('admin_traffic_summary', {}, { token: userToken });
    assert.equal(denied.status, 403);
    const anonVisits = await rpc('admin_traffic_visits', {});
    assert.ok(anonVisits.status === 401 || anonVisits.status === 403);
    const rest = await call('/rest/v1/site_visits?select=*', { token: userToken });
    assert.ok(rest.status >= 400 || (Array.isArray(rest.body) && rest.body.length === 0));
  });

  test('super admin summary and detail list match the recorded visits', async () => {
    const sum = await rpc('admin_traffic_summary', {}, { token: adminToken });
    assert.equal(sum.status, 200);
    assert.equal(sum.body.totals.visits, 2);
    assert.equal(sum.body.totals.visitors, 2);
    assert.ok(sum.body.countries.some((c) => c.key === 'TN' && c.visits === 1));
    assert.ok(sum.body.live_now >= 2);
    const tn = await rpc('admin_traffic_visits', { p_country: 'TN' }, { token: adminToken });
    assert.equal(tn.body.total, 1);
    assert.equal(tn.body.rows[0].country, 'TN');
    assert.ok(tn.body.rows[0].store_name);
    const search = await rpc('admin_traffic_visits', { p_search: 'pricing' }, { token: adminToken });
    assert.equal(search.body.total, 1);
  });

  test('page details, time on page, session path and visitor history are recorded', async () => {
    const visitor = `vis-${Math.random().toString(36).slice(2, 12)}`;
    const s1 = session();
    const android = 'Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014) AppleWebKit/537.36 Chrome/119.0.6045.163 Mobile Safari/537.36';
    const meta = { visitor_id: visitor, title: 'NovaFeet', utm_source: 'facebook', utm_campaign: 'promo-hiver', click_id: 'fbclid', screen: '412x915',
      viewport: '412x800', dpr: 2.625, tz: 'Africa/Tunis', languages: 'ar-TN, fr', connection: '4g', load_ms: 850, injected: 'x' };
    const first = await rpc('track_site_visit', { p_path: `/s/${slug}`, p_session_id: s1, p_meta: meta }, { headers: { 'user-agent': android, 'x-forwarded-for': '41.226.11.9' } });
    assert.equal(first.body.ok, true);
    assert.ok(first.body.id, 'the browser gets the visit id back to report time on page');
    const second = await rpc('track_site_visit', { p_path: `/s/${slug}/checkout`, p_session_id: s1, p_meta: { visitor_id: visitor } }, { headers: { 'user-agent': android } });
    const end = await rpc('track_visit_end', { p_visit_id: first.body.id, p_session_id: s1, p_duration_ms: 42_000, p_scroll_pct: 80 });
    assert.equal(end.body.ok, true);
    const wrong = await rpc('track_visit_end', { p_visit_id: first.body.id, p_session_id: session(), p_duration_ms: 1 });
    assert.equal(wrong.body.ok, false, 'another session cannot change the time of this visit');
    const [row] = await sql('SELECT * FROM public.site_visits WHERE id = $1', [first.body.id]);
    assert.equal(row.utm_source, 'facebook');
    assert.equal(row.click_id, 'fbclid');
    assert.equal(row.screen, '412x915');
    assert.equal(row.device_model, 'SM-A536B');
    assert.equal(row.os_version, '13');
    assert.equal(row.browser_version, '119.0');
    assert.equal(row.duration_ms, 42_000);
    assert.equal(row.scroll_pct, 80);
    assert.equal(row.is_new_visitor, true);
    // A later session from the same browser counts as a returning visitor.
    const s2 = session();
    const back = await rpc('track_site_visit', { p_path: '/', p_session_id: s2, p_meta: { visitor_id: visitor } });
    const [again] = await sql('SELECT is_new_visitor FROM public.site_visits WHERE id = $1', [back.body.id]);
    assert.equal(again.is_new_visitor, false);

    const detail = await rpc('admin_traffic_visit', { p_id: second.body.id }, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.journey.map((j) => j.path), [`/s/${slug}`, `/s/${slug}/checkout`]);
    assert.equal(detail.body.visitor.visits, 3);
    assert.equal(detail.body.visitor.sessions, 2);
    const sum = await rpc('admin_traffic_summary', {}, { token: adminToken });
    assert.ok(sum.body.campaigns.some((c) => c.key.includes('promo-hiver')));
    assert.ok(sum.body.engagement.new_visitors >= 1);
    assert.ok(sum.body.engagement.returning_visitors >= 1);
    assert.equal((await rpc('admin_traffic_visit', { p_id: first.body.id }, { token: userToken })).status, 403);
  });

  test('every server request is logged with status, timing and IP, readable by super admins only', async () => {
    await sql('DELETE FROM public.api_request_logs');
    await rpc('admin_traffic_summary', {}, { token: userToken }); // a refused call (403)
    await call('/rest/v1/rpc/does_not_exist?secret=abc', { method: 'POST', body: {}, headers: { 'x-forwarded-for': '41.226.11.77', origin: 'https://novafeet.tn' } });
    await flushApiLog();
    const rows = await sql('SELECT * FROM public.api_request_logs ORDER BY id');
    const refused = rows.find((r) => r.path === '/rest/v1/rpc/admin_traffic_summary');
    assert.equal(refused.status, 403);
    assert.equal(refused.role, 'authenticated');
    assert.ok(refused.user_id);
    assert.ok(refused.ms >= 0);
    const missing = rows.find((r) => r.path === '/rest/v1/rpc/does_not_exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.origin, 'novafeet.tn');
    assert.ok(missing.error, 'the error message is kept');
    assert.ok(!rows.some((r) => JSON.stringify(r).includes('secret=abc')), 'query strings are never stored');

    const denied = await rpc('admin_api_summary', {}, { token: userToken });
    assert.equal(denied.status, 403);
    const rest = await call('/rest/v1/api_request_logs?select=*', { token: userToken });
    assert.ok(rest.status >= 400 || (Array.isArray(rest.body) && rest.body.length === 0));
    await flushApiLog();
    const sum = await rpc('admin_api_summary', {}, { token: adminToken });
    assert.equal(sum.status, 200);
    assert.ok(sum.body.totals.requests >= 3);
    assert.ok(sum.body.totals.rejected >= 2);
    assert.ok(sum.body.endpoints.some((e) => e.key === 'POST /rest/v1/rpc/does_not_exist'));
    const list = await rpc('admin_api_requests', { p_status: '4xx', p_search: 'does_not' }, { token: adminToken });
    assert.equal(list.body.total, 1);
    assert.equal(list.body.rows[0].status, 404);
  });
}
