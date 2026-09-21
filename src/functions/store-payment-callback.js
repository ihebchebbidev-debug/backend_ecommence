// Port of supabase/functions/store-payment-callback/index.ts (anon webhook)
import { json } from './_shared/respond.js';
import crypto from 'node:crypto';

const KEY_ENV_VAR = 'PAYMENT_CREDENTIALS_ENCRYPTION_KEY';

function isProductionEnvironment() {
  const env = (process.env.APP_ENV || process.env.ENVIRONMENT || '').toLowerCase();
  return env === 'production';
}

function paymentEncryptionKey() {
  const raw = process.env[KEY_ENV_VAR];
  if (raw) {
    const keyBytes = Buffer.from(raw.trim().replace(/^["']|["']$/g, ''), 'base64');
    if (keyBytes.length !== 32) throw new Error(`Payment encryption key must decode to exactly 32 bytes (got ${keyBytes.length})`);
    return keyBytes;
  }
  if (isProductionEnvironment()) throw new Error('Payment encryption key missing');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!serviceKey) throw new Error('Payment encryption key missing');
  return crypto.createHash('sha256').update(`${serviceKey}::payment-credentials`, 'utf8').digest();
}

function decryptPaymentJson(ciphertextB64, ivB64) {
  const key = paymentEncryptionKey();
  const raw = Buffer.from(ciphertextB64, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(out);
}

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
    const fallbackOrderId = body.order_id || body.orderId || null;
    if (!fallbackOrderId) return json(res, { ok: false, message: 'Commande introuvable par ref' }, 404);
    const fo = await ctx.q(
      'SELECT id, store_id, amount, currency, payment_status, payment_ref, payment_provider FROM public.orders WHERE id=$1',
      [fallbackOrderId],
    ).then((r) => r[0]);
    if (!fo) return json(res, { ok: false, message: 'Commande introuvable' }, 404);
    await ctx.q('UPDATE public.orders SET payment_ref=$1, updated_at=now() WHERE id=$2', [String(paymentRef), fo.id]);
    order = fo;
  }

  if (order.payment_status === 'paid') return json(res, { ok: true, message: 'Déjà payé', idempotent: true });

  const provider = (order.payment_provider || '').toLowerCase();
  if (!provider) return json(res, { ok: false, message: 'Provider manquant' }, 400);

  const integration = await ctx.q(
    'SELECT credentials_encrypted, credentials_iv, is_active, connection_status FROM public.store_payment_integrations WHERE store_id=$1 AND is_active=true',
    [order.store_id],
  ).then((r) => r[0]);
  if (!integration || !integration.is_active || integration.connection_status !== 'connected') {
    return json(res, { ok: false, message: 'Intégration inactive' }, 409);
  }

  let creds;
  try { creds = decryptPaymentJson(integration.credentials_encrypted, integration.credentials_iv); }
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
    gatewayAmountTnd = Number(p.amount || p.amountDue || 0) / 1000;
    gatewayRef = p.id || paymentRef;
  } else if (provider === 'paymee') {
    const apiKey = creds.api_key || '';
    if (!apiKey) return json(res, { ok: false, message: 'Clé Paymee manquante' }, 500);
    const psBool = body.payment_status;
    const psNum = psBool === true ? 1 : 0;
    const expected = md5hex(`${paymentRef}${psNum}${apiKey}`);
    const received = body.check_sum || '';
    if (!received || !timingSafeEqualStr(String(received), expected)) {
      await ctx.q('UPDATE public.orders SET payment_status=$1, updated_at=now() WHERE id=$2', ['failed', order.id]);
      return json(res, { ok: false, message: 'Checksum invalide' }, 400);
    }
    gatewayStatus = psBool === true ? 'completed' : 'failed';
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
      await ctx.q('UPDATE public.orders SET payment_status=$1, updated_at=now() WHERE id=$2', ['failed', order.id]);
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
