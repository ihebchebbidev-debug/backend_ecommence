// Public: reports shop events to Meta's Conversions API with the seller's own token.
// Purchase amount and currency come from the stored order, never from the shopper's browser.
// Contact details are only sent when the shopper ticked the agreement at checkout.
import { json, methodGuard } from './_shared/respond.js';
import { hashedUserData } from '../lib/metaMatch.js';
import { purchaseCapabilityMatches } from '../lib/metaCheckoutConsent.js';
import { getMetaCreds, META_GRAPH as GRAPH } from '../lib/metaCreds.js';

const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const BROWSER_EVENTS = new Set(['ViewContent', 'AddToCart', 'InitiateCheckout']);

export function purchaseAllowed(order, now = Date.now()) {
  if (!order) return false;
  const age = now - new Date(order.created_at || 0).getTime();
  if (!(age >= 0 && age < MAX_AGE_MS)) return false;
  // Card orders only count once paid; cash-on-delivery orders count when placed.
  if (order.payment_provider && order.payment_provider !== 'cod' && order.payment_status !== 'paid') return false;
  return true;
}

// Light per-visitor limit so the public endpoint cannot flood a seller's pixel.
const hits = new Map();
export function rateLimited(ip, now = Date.now(), max = 60) {
  const h = hits.get(ip);
  if (!h || now - h.t > 60000) { hits.set(ip, { t: now, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  h.n += 1;
  return h.n > max;
}

const str = (v, n = 500) => (v == null ? '' : String(v).slice(0, n));

export default async function storefrontMetaEvent(req, res, ctx) {
  if (methodGuard(req, res)) return;
  const b = req.body || {};
  const store_id = str(b.store_id, 64);
  const event_name = b.event_name ? str(b.event_name, 40) : 'Purchase';
  if (!store_id) return json(res, { error: 'store_id is required' }, 400);
  if (event_name !== 'Purchase' && !BROWSER_EVENTS.has(event_name)) return json(res, { error: 'unsupported event' }, 400);
  if (rateLimited(req.ip || 'x')) return json(res, { ok: false, skipped: true }, 429);

  const creds = await getMetaCreds(ctx, store_id);
  if (!creds.pixelId || !creds.accessToken) return json(res, { ok: false, skipped: true });

  const user_data = { client_user_agent: str(req.headers['user-agent']), client_ip_address: req.ip };
  if (b.fbp) user_data.fbp = str(b.fbp, 200);
  if (b.fbc) user_data.fbc = str(b.fbc, 400);

  let event;
  if (event_name === 'Purchase') {
    const order_id = str(b.order_id, 64);
    if (!order_id) return json(res, { error: 'order_id is required' }, 400);
    const order = await ctx.q(
      `SELECT id, amount, currency, payment_status, payment_provider, created_at, checkout_request_id, client_id, client_name, client_phone, client_phone2, city, region
         FROM public.orders WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL`,
      [order_id, store_id],
    ).then((r) => r[0]).catch(() => null);
    if (!purchaseAllowed(order)) return json(res, { ok: false, skipped: true });
    if (!purchaseCapabilityMatches(order, b.checkout_request_id)) return json(res, { error: 'CHECKOUT_REQUIRED' }, 403);

    // Only evidence saved inside successful checkout can authorize customer matching.
    const row = await ctx.q(`SELECT accepted,withdrawn_at,email_sha256,country,recorded_at_checkout
      FROM public.ad_match_consents WHERE order_id=$1 AND store_id=$2`, [order.id, store_id]).then(r => r[0]);
    if (row?.recorded_at_checkout && row.accepted && !row.withdrawn_at) {
      Object.assign(user_data, hashedUserData(order, { country: row.country }));
      if (row.email_sha256) user_data.em = [row.email_sha256];
    }

    event = {
      event_name: 'Purchase',
      event_time: Math.floor(new Date(order.created_at).getTime() / 1000),
      event_id: String(order.id),
      custom_data: {
        value: Number(order.amount || 0),
        currency: String(order.currency || 'TND').toUpperCase(),
        content_type: 'product',
        ...(Array.isArray(b.content_ids) ? { content_ids: b.content_ids.slice(0, 50).map((x) => str(x, 64)) } : {}),
        ...(Number(b.num_items) > 0 ? { num_items: Math.min(999, Math.floor(Number(b.num_items))) } : {}),
      },
    };
  } else {
    const event_id = str(b.event_id, 80);
    if (!event_id) return json(res, { error: 'event_id is required' }, 400);
    const value = Math.max(0, Math.min(1e7, Number(b.value) || 0));
    event = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      custom_data: {
        value,
        currency: str(b.currency || 'TND', 3).toUpperCase(),
        content_type: 'product',
        content_ids: Array.isArray(b.content_ids) ? b.content_ids.slice(0, 50).map((x) => str(x, 64)) : [],
        ...(Number(b.num_items) > 0 ? { num_items: Math.min(999, Math.floor(Number(b.num_items))) } : {}),
      },
    };
  }

  // Durable "already reported" check (survives restarts, shared across servers).
  let fresh;
  try { fresh = await ctx.q(
    `INSERT INTO public.meta_capi_sent (store_id, event_name, event_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`,
    [store_id, event.event_name, event.event_id],
  ).then((r) => r.length > 0); }
  catch { return json(res, { error: 'DEDUP_UNAVAILABLE' }, 503); }
  if (!fresh) return json(res, { ok: true, duplicate: true });

  const payload = {
    data: [{ ...event, action_source: 'website', event_source_url: str(b.event_source_url, 1000), user_data }],
    partner_agent: 'lovable',
  };
  if (creds.testEventCode) payload.test_event_code = creds.testEventCode;
  const forget = () => ctx.q('DELETE FROM public.meta_capi_sent WHERE store_id=$1 AND event_name=$2 AND event_id=$3', [store_id, event.event_name, event.event_id]).catch(() => {});
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(creds.pixelId)}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.accessToken}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    const result = await r.json().catch(() => ({}));
    const accepted = r.ok && !result.error && typeof result.events_received === 'number' && result.events_received > 0;
    if (!accepted) await forget();
    return json(res, { ok: accepted });
  } catch {
    await forget();
    return json(res, { ok: false }, 502);
  }
}
