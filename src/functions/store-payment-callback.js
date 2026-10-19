// Port of supabase/functions/store-payment-callback/index.ts (anon webhook)
import { json } from './_shared/respond.js';
import crypto from 'node:crypto';

import { decryptPaymentJson } from './_shared/paymentCrypto.js';
import { konnectBase, paymeeBase, FLOUCI_BASE, clictopayCall } from './_shared/storeGateways.js';

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

  // Stripe sends an event whose session id is data.object.id (body.id is the event id).
  const stripeSession = body?.object === 'event' ? body?.data?.object?.id : null;
  if (body?.object === 'event' && !String(stripeSession || '').startsWith('cs_')) {
    return json(res, { ok: true, ignored: true }); // events we don't use
  }
  // Shopper back from the gateway: use the reference we stored; the provider is re-asked below.
  if (body.return_check && body.order_id && !body.token && !body.payment_id) {
    const o = await ctx.q('SELECT payment_ref FROM public.orders WHERE id=$1', [String(body.order_id)]).then((r) => r[0]).catch(() => null);
    if (!o?.payment_ref) return json(res, { ok: false, message: 'Aucun paiement en cours' }, 404);
    body = { ...body, payment_ref: o.payment_ref };
  }
  const paymentRef = stripeSession || body.payment_id || body.payment_ref || body.paymentRef || body.id || body.reference || body.token || null;
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
    'SELECT credentials_encrypted, credentials_iv, credentials_version, is_active, connection_status FROM public.store_payment_integrations WHERE store_id=$1 AND provider=$2 AND is_active=true',
    [order.store_id, provider],
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
    const r = await fetch(`${konnectBase(creds)}/payments/${encodeURIComponent(paymentRef)}`, {
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
    if (!body.check_sum) {
      // Return path (no signed webhook): ask Paymee for the real status.
      const r = await fetch(`${paymeeBase(creds)}/payments/${encodeURIComponent(paymentRef)}/check`, {
        headers: { Authorization: `Token ${apiKey}` }, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return json(res, { ok: false, message: `Paymee HTTP ${r.status}` }, 502);
      const d = await r.json().catch(() => ({}));
      body = { ...body, payment_status: d?.data?.payment_status, amount: d?.data?.amount, check_sum: md5hex(`${paymentRef}${d?.data?.payment_status ? 1 : 0}${apiKey}`) };
    }
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
  } else if (provider === 'flouci') {
    // Never trust the webhook body: ask Flouci for the payment's real state.
    const pub = creds.app_public || '';
    const sec = creds.app_secret || '';
    if (!pub || !sec) return json(res, { ok: false, message: 'Clés Flouci manquantes' }, 500);
    const r = await fetch(`${FLOUCI_BASE}/verify_payment/${encodeURIComponent(paymentRef)}`, {
      headers: { Authorization: `Bearer ${pub}:${sec}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return json(res, { ok: false, message: `Flouci HTTP ${r.status}` }, 502);
    const d = await r.json().catch(() => ({}));
    if (d.success === false) return json(res, { ok: false, message: 'Flouci: paiement introuvable' }, 404);
    const result = d.result || {};
    gatewayStatus = String(result.status || '').toLowerCase() === 'success' ? 'completed' : String(result.status || '').toLowerCase();
    gatewayAmountTnd = Number(result.amount || 0) / 1000;
    gatewayRef = paymentRef;
    const tracking = result.developer_tracking_id || null;
    if (tracking && String(tracking) !== String(order.id)) {
      return json(res, { ok: false, message: 'Paiement lié à une autre commande' }, 409);
    }
  } else if (provider === 'stripe') {
    // Re-read the Checkout Session with the seller's key instead of trusting the event.
    const key = creds.secret_key || '';
    if (!key) return json(res, { ok: false, message: 'Clé Stripe manquante' }, 500);
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(paymentRef)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return json(res, { ok: false, message: `Stripe HTTP ${r.status}` }, 502);
    const s = await r.json();
    if (s.client_reference_id && String(s.client_reference_id) !== String(order.id)) {
      return json(res, { ok: false, message: 'Paiement lié à une autre commande' }, 409);
    }
    gatewayStatus = s.payment_status === 'paid' ? 'completed' : s.status === 'expired' ? 'expired' : 'pending';
    gatewayAmountTnd = Number(s.amount_total || 0) / 100;
    gatewayRef = s.id;
  } else if (provider === 'clictopay') {
    if (!creds.username || !creds.password) return json(res, { ok: false, message: 'Identifiants ClicToPay manquants' }, 500);
    const { ok, status, data } = await clictopayCall(creds, 'getOrderStatusExtended.do', { orderId: String(paymentRef), language: 'fr' });
    if (!ok) return json(res, { ok: false, message: `ClicToPay HTTP ${status}` }, 502);
    // orderStatus: 2 = paid, 3 = reversed, 4 = refunded, 6 = declined; 0/1 still in progress.
    const st = Number(data.orderStatus);
    gatewayStatus = st === 2 ? 'completed' : [3, 4, 6].includes(st) ? 'failed' : 'pending';
    gatewayAmountTnd = Number(data.amount || 0) / 1000;
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
