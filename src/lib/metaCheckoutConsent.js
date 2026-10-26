import { normalizeEmail, sha256 } from './metaMatch.js';

export function checkoutConsent(value, email) {
  if (!value || typeof value.accepted !== 'boolean' || typeof value.text !== 'string' || !value.text.trim()) return null;
  const normalized = normalizeEmail(email);
  return { accepted: value.accepted, version: Number.isInteger(value.v) && value.v > 0 ? value.v : 1,
    text: value.text.slice(0, 1000), country: /^[a-z]{2}$/i.test(value.country || '') ? value.country.toLowerCase() : null,
    emailHash: normalized ? sha256(normalized) : null };
}
export function purchaseCapabilityMatches(order, requestId) {
  return typeof requestId === 'string' && !!order?.checkout_request_id && requestId === order.checkout_request_id;
}
export async function recordCheckoutConsent(db, orderId, storeId, consent) {
  if (!consent) return;
  await db.q(`INSERT INTO public.ad_match_consents (order_id,store_id,accepted,notice_version,notice_text,email_sha256,country,recorded_at_checkout)
    VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT (order_id) DO NOTHING`,
    [orderId, storeId, consent.accepted, consent.version, consent.text, consent.emailHash, consent.country]);
}