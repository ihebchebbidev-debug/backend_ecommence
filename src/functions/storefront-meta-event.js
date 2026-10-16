// Public: reports a shop purchase to Meta's Conversions API with the seller's own token.
// Amount and currency come from the stored order, never from the shopper's browser.
import { json, methodGuard } from './_shared/respond.js';

const sent = new Map(); // order id → time, so a reload or replay never reports twice
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function purchaseAllowed(order, now = Date.now()) {
  if (!order) return false;
  const age = now - new Date(order.created_at || 0).getTime();
  if (!(age >= 0 && age < MAX_AGE_MS)) return false;
  // Card orders only count once paid; cash-on-delivery orders count when placed.
  if (order.payment_provider && order.payment_status !== 'paid') return false;
  return true;
}

export default async function storefrontMetaEvent(req, res, ctx) {
  if (methodGuard(req, res)) return;
  const { store_id, order_id, fbp, fbc, event_source_url } = req.body || {};
  if (!store_id || !order_id) return json(res, { error: 'store_id and order_id are required' }, 400);
  if (sent.has(order_id)) return json(res, { ok: true, duplicate: true });

  const order = await ctx.q(
    'SELECT id, amount, currency, payment_status, payment_provider, created_at FROM public.orders WHERE id=$1 AND store_id=$2',
    [order_id, store_id],
  ).then((r) => r[0]).catch(() => null);
  if (!purchaseAllowed(order)) return json(res, { ok: false, skipped: true });

  const settings = await ctx.q(
    `SELECT key, value FROM public.store_settings WHERE store_id=$1 AND key IN ('meta_pixel_id','meta_access_token')`,
    [store_id],
  );
  const map = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  if (!map.meta_pixel_id || !map.meta_access_token) return json(res, { ok: false, skipped: true });

  for (const [k, t] of sent) if (Date.now() - t > MAX_AGE_MS) sent.delete(k);
  sent.set(order_id, Date.now());

  const user_data = { client_user_agent: String(req.headers['user-agent'] || ''), client_ip_address: req.ip };
  if (fbp) user_data.fbp = String(fbp);
  if (fbc) user_data.fbc = String(fbc);
  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(new Date(order.created_at).getTime() / 1000),
      event_id: String(order.id),
      action_source: 'website',
      event_source_url: String(event_source_url || ''),
      user_data,
      custom_data: { value: Number(order.amount || 0), currency: String(order.currency || 'TND').toUpperCase() },
    }],
    access_token: map.meta_access_token,
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(map.meta_pixel_id)}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) sent.delete(order_id);
    return json(res, { ok: r.ok });
  } catch {
    sent.delete(order_id);
    return json(res, { ok: false }, 502);
  }
}
