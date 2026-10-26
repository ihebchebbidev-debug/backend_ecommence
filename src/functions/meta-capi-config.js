// Seller-only private Meta configuration. Responses never include credentials or fragments.
import { json, methodGuard } from './_shared/respond.js';
import { getMetaCreds, verifyPixelToken, canManageMeta, META_GRAPH } from '../lib/metaCreds.js';

export default async function metaCapiConfig(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Unauthorized' }, 401);
  const { store_id, action = 'status' } = req.body || {};
  if (!store_id) return json(res, { error: 'STORE_REQUIRED' }, 400);
  if (!['status', 'save', 'remove', 'test'].includes(action)) return json(res, { error: 'ACTION_INVALID' }, 400);
  try {
    if (!(await canManageMeta(ctx, store_id))) return json(res, { error: 'Forbidden' }, 403);
    const creds = await getMetaCreds(ctx, store_id);
    if (action === 'remove') {
      await ctx.q('DELETE FROM public.store_meta_capi WHERE store_id=$1', [store_id]);
      return json(res, { ok: true, has_token: false, pixel_id: creds.pixelId, test_event_code: null });
    }
    if (action === 'save') {
      const pixelId = String(req.body.pixel_id ?? creds.pixelId ?? '').trim();
      if (!/^\d{5,20}$/.test(pixelId)) return json(res, { error: 'PIXEL_INVALID' }, 400);
      const token = String(req.body.access_token || '').trim();
      const testCode = String(req.body.test_event_code ?? creds.testEventCode ?? '').trim();
      if (testCode && !/^[A-Za-z0-9_-]{1,40}$/.test(testCode)) return json(res, { error: 'TEST_CODE_INVALID' }, 400);
      const accessToken = token || creds.accessToken;
      if (!accessToken) {
        if (testCode) return json(res, { error: 'TOKEN_MISSING' }, 400);
        await ctx.q(`INSERT INTO public.store_settings (store_id,key,value,updated_at) VALUES ($1,'meta_pixel_id',$2,now())
          ON CONFLICT (store_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [store_id, pixelId]);
        return json(res, { ok: true, has_token: false, pixel_id: pixelId, test_event_code: null });
      }
      if (token && /\s/.test(token)) return json(res, { error: 'TOKEN_INVALID' }, 400);
      const verified = await verifyPixelToken(pixelId, accessToken);
      if (!verified.ok) return json(res, { error: verified.error }, 400);
      await ctx.tx(async (db) => {
        await db.q(`INSERT INTO public.store_settings (store_id,key,value,updated_at) VALUES ($1,'meta_pixel_id',$2,now())
          ON CONFLICT (store_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [store_id, pixelId]);
        await db.q(`INSERT INTO public.store_meta_capi (store_id,access_token,test_event_code,updated_by,updated_at)
          VALUES ($1,$2,$3,$4,now()) ON CONFLICT (store_id) DO UPDATE SET access_token=EXCLUDED.access_token,
          test_event_code=EXCLUDED.test_event_code,updated_by=EXCLUDED.updated_by,updated_at=now()`, [store_id, accessToken, testCode || null, ctx.userId]);
      });
      return json(res, { ok: true, has_token: true, pixel_ok: true, pixel_id: pixelId, pixel_name: verified.name, test_event_code: testCode || null });
    }
    if (action === 'test') {
      // A connection probe sends no customer data. Test Events is mandatory to avoid real conversions.
      if (!creds.pixelId || !creds.accessToken) return json(res, { error: 'TOKEN_MISSING' }, 400);
      if (!creds.testEventCode) return json(res, { error: 'TEST_CODE_REQUIRED' }, 400);
      const response = await fetch(`${META_GRAPH}/${encodeURIComponent(creds.pixelId)}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.accessToken}` },
        body: JSON.stringify({ partner_agent: 'lovable', test_event_code: creds.testEventCode, data: [{
          event_name: 'PageView', event_time: Math.floor(Date.now()/1000), event_id: `connection-test-${crypto.randomUUID()}`,
          action_source: 'website', event_source_url: 'https://www.facebook.com/',
          user_data: { client_user_agent: 'Ecommence connection test (synthetic)', client_ip_address: '192.0.2.1' },
        }] }), signal: AbortSignal.timeout(10000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error || !(result.events_received > 0)) return json(res, { error: 'META_TEST_REJECTED' }, 400);
      return json(res, { ok: true, events_received: result.events_received });
    }
    const out = { ok: true, pixel_id: creds.pixelId, has_token: !!creds.accessToken, test_event_code: creds.testEventCode };
    if (creds.pixelId && creds.accessToken) {
      const verified = await verifyPixelToken(creds.pixelId, creds.accessToken);
      Object.assign(out, { pixel_ok: verified.ok, pixel_name: verified.name ?? null, meta_error: verified.ok ? null : verified.error });
    }
    return json(res, out);
  } catch {
    return json(res, { error: 'CONFIG_UNAVAILABLE' }, 503);
  }
}
