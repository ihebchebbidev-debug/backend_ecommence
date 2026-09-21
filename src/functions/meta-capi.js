// Port of supabase/functions/meta-capi/index.ts
import crypto from 'node:crypto';
import { json, methodGuard } from './_shared/respond.js';

const sha256 = (raw) => crypto.createHash('sha256').update(String(raw).toLowerCase().trim(), 'utf8').digest('hex');

async function buildUserData(raw = {}) {
  const ud = {};
  const piiMap = [
    ['em', raw.email],
    ['ph', raw.phone ? String(raw.phone).replace(/\D/g, '') : undefined],
    ['fn', raw.first_name],
    ['ln', raw.last_name],
    ['ct', raw.city],
    ['zp', raw.zip],
    ['country', raw.country],
    ['external_id', raw.external_id],
  ];
  for (const [key, val] of piiMap) {
    if (val) ud[key] = sha256(val);
  }
  if (raw.fbc) ud.fbc = raw.fbc;
  if (raw.fbp) ud.fbp = raw.fbp;
  if (raw.client_ip_address) ud.client_ip_address = raw.client_ip_address;
  if (raw.client_user_agent) ud.client_user_agent = raw.client_user_agent;
  return ud;
}

export default async function metaCapi(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Unauthorized' }, 401);

  try {
    const { pixel_id, events, test_event_code, store_id } = req.body || {};

    if (!pixel_id || !Array.isArray(events) || events.length === 0) {
      return json(res, { error: 'pixel_id and events[] are required' }, 400);
    }

    let accessToken = null;

    if (store_id) {
      const member = await ctx.q(
        `SELECT user_id FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND status='active'`,
        [store_id, ctx.userId],
      ).then((r) => r[0]);

      const adminRole = await ctx.q('SELECT role FROM public.admin_roles WHERE user_id=$1', [ctx.userId]).then((r) => r[0]);
      const isSuperAdmin = adminRole?.role === 'super_admin' || adminRole?.role === 'limited_super_admin';

      if (!member && !isSuperAdmin) {
        return json(res, { error: 'Forbidden: no access to this store' }, 403);
      }

      const setting = await ctx.q(
        `SELECT value FROM public.store_settings WHERE store_id=$1 AND key='meta_access_token'`,
        [store_id],
      ).then((r) => r[0]);
      accessToken = setting?.value || null;
    } else {
      // Both names are accepted: META_ACCESS_TOKEN (legacy) and META_CAPI_ACCESS_TOKEN (documented).
      accessToken = process.env.META_ACCESS_TOKEN || process.env.META_CAPI_ACCESS_TOKEN || null;
    }

    if (!accessToken) {
      return json(res, { error: 'Meta CAPI token not configured' }, 400);
    }

    const processedEvents = await Promise.all(
      events.map(async (ev) => ({
        event_name: ev.event_name,
        event_time: ev.event_time ?? Math.floor(Date.now() / 1000),
        event_source_url: ev.event_source_url ?? '',
        action_source: ev.action_source ?? 'website',
        user_data: ev.user_data ? await buildUserData(ev.user_data) : {},
        custom_data: ev.custom_data ?? {},
      })),
    );

    const payload = { data: processedEvents, access_token: accessToken };
    if (test_event_code) payload.test_event_code = test_event_code;

    const metaRes = await fetch(`https://graph.facebook.com/v18.0/${pixel_id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await metaRes.json();
    return json(res, result, metaRes.status);
  } catch (err) {
    return json(res, { error: String(err) }, 500);
  }
}
