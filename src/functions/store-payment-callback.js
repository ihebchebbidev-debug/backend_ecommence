// Port of supabase/functions/store-payment-callback/index.ts (anon webhook)
import { json } from './_shared/respond.js';
import crypto from 'node:crypto';

import { decryptPaymentJson } from './_shared/paymentCrypto.js';

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function md5hex(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

export default async function storePaymentCallback(req, res, ctx) {
  let body = {};
  if (req.method === 'GET') {
    for (const [k, v] of Object.entries(req.query || {})) body[k] = v;
  } else {
    body = req.body || {};
  }

  const paymentRef = body.payment_ref || body.paymentRef || body.id || body.reference || body.token || null;
  if (!paymentRef) return json(res, { ok: false, message: 'payment_ref manquant' }, 400);

  let order = await ctx.q(
    'SELECT id, store_id, amount, currency, payment_status, payment_ref, payment_provider FROM public.orders WHERE payment_ref=$1',
    [String(paymentRef)],
  ).then((r) => r[0]);

  if (!order) {
    // Fallback only for orders that never received a gateway reference; never
    // overwrite an existing reference, and only persist it after verification.
    const fallbackOrderId = body.order_id || body.orderId || null;
    if (!fallbackOrderId) return json(res, { ok: false, message: 'Commande introuvable par ref' }, 404);
    const fo = await ctx.q(
      'SELECT id, store_id, amount, currency, payment_status, payment_ref, payment_provider FROM public.orders WHERE id=$1',
      [fallbackOrderId],
    ).then((r) => r[0]);
    if (!fo) return json(res, { ok: false, message: 'Commande introuvable' }, 404);
    if (fo.payment_ref && fo.payment_ref !== String(paymentRef)) {
      return json(res, { ok: false, message: 'Référence de paiement différente' }, 409);
    }
    order = fo;
  }

  if (order.payment_status === 'paid') return json(res, { ok: true, message: 'Déjà payé', idempotent: true });

  const provider = (order.payment_provider || '').toLowerCase();
  if (!provider) return json(res, { ok: false, message: 'Provider manquant' }, 400);

  const integration = await ctx.q(
    'SELECT credentials_encrypted, credentials_iv, credentials_version, is_active, connection_status FROM public.store_payment_integrations WHERE store_id=$1 AND is_active=true',
    [order.store_id],
  ).then((r) => r[0]);
  if (!integration || !integration.is_active || integration.connection_status !== 'connected') {
    return json(res, { ok: false, message: 'Intégration inactive' }, 409);
  }

  let creds;
  try { creds = decryptPaymentJson(integration.credentials_encrypted, integration.credentials_iv, integration.credentials_version); }
  catch { return json(res, { ok: false, message: 'Erreur de déchiffrement' }, 500); }

  let gatewayStatus = '';
  let gatewayAmountTnd = null;
  let gatewayRef = null;

  if (provider === 'konnect') {
    const apiKey = creds.api_key || '';
    if (!apiKey) return json(res, { ok: false, message: 'Clé Konnect manquante' }, 500);
    const r = await fetch(`https://api.konnect.network/api/v2/payments/${paymentRef}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return json(res, { ok: false, message: `Konnect HTTP ${r.status}` }, 502);
    const d = await r.json();
    const p = d.payment || d;
    gatewayStatus = String(p.status || '').toLowerCase();
    // Konnect amounts are in millimes for TND and in cents for EUR/USD.
    const unit = String(p.token || order.currency || 'TND').toUpperCase() === 'TND' ? 1000 : 100;
    gatewayAmountTnd = Number(p.amount || p.amountDue || 0) / unit;
    gatewayRef = p.id || paymentRef;
    const gatewayOrderId = p.orderId || p.order_id || null;
    if (gatewayOrderId && String(gatewayOrderId) !== String(order.id)) {
      return json(res, { ok: false, message: 'Paiement lié à une autre commande' }, 409);
    }
  } else if (provider === 'paymee') {
    const apiKey = creds.api_key || '';
    if (!apiKey) return json(res, { ok: false, message: 'Clé Paymee manquante' }, 500);
    const psRaw = body.payment_status;
    const psBool = psRaw === true || psRaw === 1 || psRaw === '1' || String(psRaw).toLowerCase() === 'true';
    const psNum = psBool ? 1 : 0;
    const expected = md5hex(`${paymentRef}${psNum}${apiKey}`);
    const received = body.check_sum || '';
    if (!received || !timingSafeEqualStr(String(received).toLowerCase(), expected)) {
      // Unsigned callbacks must not change the order: anyone can call this URL.
      return json(res, { ok: false, message: 'Checksum invalide' }, 400);
    }
    gatewayStatus = psBool ? 'completed' : 'failed';
    gatewayAmountTnd = Number(body.amount || 0);
    gatewayRef = paymentRef;
  } else {
    return json(res, { ok: false, message: 'Provider non supporté' }, 400);
  }

  const isPaid = ['completed', 'paid', 'success', 'successful'].includes(gatewayStatus);
  const isFailed = ['failed', 'expired', 'canceled', 'cancelled', 'declined'].includes(gatewayStatus);

  if (isPaid && gatewayAmountTnd !== null) {
    const expected = Number(order.amount) || 0;
    if (Math.abs(gatewayAmountTnd - expected) > 0.001) {
      // Keep the order pending for manual review instead of marking it failed.
      return json(res, { ok: false, message: 'Montant mismatch' }, 400);
    }
  }

  const newStatus = isPaid ? 'paid' : isFailed ? 'failed' : 'pending';
  if (gatewayRef) {
    await ctx.q('UPDATE public.orders SET payment_status=$1, payment_ref=$2, updated_at=now() WHERE id=$3', [newStatus, String(gatewayRef), order.id]);
  } else {
    await ctx.q('UPDATE public.orders SET payment_status=$1, updated_at=now() WHERE id=$2', [newStatus, order.id]);
  }

  return json(res, { ok: true, status: newStatus });
}
