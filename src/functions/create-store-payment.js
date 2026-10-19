// Port of supabase/functions/create-store-payment/index.ts (anon storefront checkout)
import { json, methodGuard } from './_shared/respond.js';

import { decryptPaymentJson } from './_shared/paymentCrypto.js';

export const STRIPE_CURRENCIES = ['EUR', 'USD', 'GBP', 'CAD', 'CHF', 'MAD', 'DZD', 'AED', 'SAR', 'QAR'];

/** Appends query params whatever the URL already contains. */
export function withParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export default async function createStorePayment(req, res, ctx) {
  if (methodGuard(req, res)) return;
  const { order_id, store_id, successUrl, failUrl, provider: requestedProvider } = req.body || {};
  if (!order_id || !store_id || !successUrl || !failUrl) return json(res, { error: 'Paramètres manquants' }, 400);

  const order = await ctx.q(
    'SELECT id, order_number, store_id, amount, currency, status, payment_status, client_name, client_phone FROM public.orders WHERE id=$1',
    [order_id],
  ).then((r) => r[0]);
  if (!order) return json(res, { error: 'Commande introuvable' }, 404);
  if (order.store_id !== store_id) return json(res, { error: 'Store mismatch' }, 403);
  if (order.payment_status === 'paid') return json(res, { error: 'Commande déjà payée' }, 409);

  const amountTnd = Number(order.amount) || 0;
  if (amountTnd <= 0) return json(res, { error: 'Montant invalide' }, 400);

  const integration = await ctx.q(
    // Use the gateway the shopper picked; without one, any connected gateway.
    `SELECT id, provider, credentials_encrypted, credentials_iv, credentials_version, is_active, connection_status
       FROM public.store_payment_integrations
      WHERE store_id=$1 AND is_active=true AND connection_status='connected' AND ($2::text IS NULL OR provider=$2)
      ORDER BY provider LIMIT 1`,
    [store_id, requestedProvider ? String(requestedProvider) : null],
  ).then((r) => r[0]);
  if (!integration || !integration.is_active || integration.connection_status !== 'connected') {
    return json(res, { error: 'Aucune passerelle de paiement active pour ce magasin' }, 409);
  }
  if (!integration.credentials_encrypted || !integration.credentials_iv) {
    return json(res, { error: 'Identifiants de paiement manquants' }, 500);
  }

  // Gateways only charge the currencies they support; never relabel a USD order as TND.
  const currency = String(order.currency || 'TND').trim().toUpperCase();
  const SUPPORTED = {
    konnect: ['TND', 'EUR', 'USD'],
    paymee: ['TND'],
    flouci: ['TND'],
    // Stripe does not support TND; sellers selling abroad use these.
    stripe: STRIPE_CURRENCIES,
  };
  const supported = SUPPORTED[integration.provider] || ['TND'];
  if (!supported.includes(currency)) {
    return json(res, { error: `Devise ${currency} non prise en charge par ${integration.provider}` }, 409);
  }

  let creds;
  try { creds = decryptPaymentJson(integration.credentials_encrypted, integration.credentials_iv, integration.credentials_version); }
  catch { return json(res, { error: 'Erreur de déchiffrement des identifiants' }, 500); }

  await ctx.q(
    'UPDATE public.orders SET payment_status=$1, payment_provider=$2, updated_at=now() WHERE id=$3',
    ['pending', integration.provider, order_id],
  );

  const webhook = `${(process.env.PUBLIC_FUNCTIONS_BASE_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/functions/v1/store-payment-callback`;
  const description = `Commande ${order.order_number}`;

  if (integration.provider === 'konnect') {
    const apiKey = creds.api_key || '';
    const walletId = creds.receiver_wallet_id || '';
    if (!apiKey || !walletId) return json(res, { error: 'Configuration Konnect incomplète' }, 500);

    const konnectRes = await fetch('https://api.konnect.network/api/v2/payments/init-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverWalletId: walletId,
        token: currency,
        amount: Math.round(amountTnd * (currency === 'TND' ? 1000 : 100)),
        type: 'immediate',
        description,
        acceptedPaymentMethods: ['wallet', 'bank_card', 'e-DINAR'],
        lifespan: 30,
        checkoutForm: true,
        addPaymentFeesToAmount: true,
        firstName: (order.client_name || '').split(' ')[0] || '',
        lastName: (order.client_name || '').split(' ').slice(1).join(' ') || '',
        email: '',
        orderId: order_id,
        webhook,
        successUrl: `${successUrl}?order=${order_id}&status=success`,
        failUrl: `${failUrl}?order=${order_id}&status=failed`,
        theme: 'light',
      }),
    });

    if (!konnectRes.ok) {
      const txt = await konnectRes.text().catch(() => '');
      return json(res, { error: `Konnect HTTP ${konnectRes.status}${txt ? `: ${txt.slice(0, 160)}` : ''}` }, 502);
    }

    const data = await konnectRes.json();
    const paymentRef = data.paymentRef || null;
    if (!data.payUrl || !paymentRef) return json(res, { error: 'Konnect n’a pas renvoyé de lien de paiement' }, 502);
    if (paymentRef) {
      await ctx.q('UPDATE public.orders SET payment_ref=$1, updated_at=now() WHERE id=$2', [String(paymentRef), order_id]);
    }
    return json(res, { paymentUrl: data.payUrl, reference: paymentRef, provider: 'konnect' });
  }

  if (integration.provider === 'paymee') {
    const apiKey = creds.api_key || '';
    if (!apiKey) return json(res, { error: 'Configuration Paymee incomplète' }, 500);

    const paymeeRes = await fetch('https://api.paymee.tn/api/v1/payments/create', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountTnd.toFixed(3),
        note: description,
        first_name: (order.client_name || '').split(' ')[0] || '',
        last_name: (order.client_name || '').split(' ').slice(1).join(' ') || '',
        email: '',
        phone: order.client_phone || '',
        return_url: `${successUrl}?order=${order_id}&status=success`,
        cancel_url: `${failUrl}?order=${order_id}&status=failed`,
        webhook_url: webhook,
      }),
    });

    if (!paymeeRes.ok) {
      const txt = await paymeeRes.text().catch(() => '');
      return json(res, { error: `Paymee HTTP ${paymeeRes.status}${txt ? `: ${txt.slice(0, 160)}` : ''}` }, 502);
    }

    const data = await paymeeRes.json();
    // The Paymee webhook identifies the payment by its token (also used in the checksum).
    const paymentRef = data?.data?.token || data?.token || data?.data?.reference || null;
    const paymentUrl = data?.data?.payment_url || data?.payment_url || null;
    if (data?.status === false || !paymentRef || !paymentUrl) {
      return json(res, { error: `Paymee: ${data?.message || 'lien de paiement non renvoyé'}` }, 502);
    }
    if (paymentRef) {
      await ctx.q('UPDATE public.orders SET payment_ref=$1, updated_at=now() WHERE id=$2', [String(paymentRef), order_id]);
    }
    return json(res, { paymentUrl, reference: paymentRef, provider: 'paymee' });
  }

  if (integration.provider === 'flouci') {
    const pub = creds.app_public || '';
    const sec = creds.app_secret || '';
    if (!pub || !sec) return json(res, { error: 'Configuration Flouci incomplète' }, 500);
    const r = await fetch('https://developers.flouci.com/api/v2/generate_payment', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pub}:${sec}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: String(Math.round(amountTnd * 1000)), // millimes
        accept_card: 'true',
        session_timeout_secs: 1200,
        success_link: withParams(successUrl, { order: order_id, status: 'success' }),
        fail_link: withParams(failUrl, { order: order_id, status: 'failed' }),
        developer_tracking_id: order_id,
        webhook,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    const paymentId = data?.result?.payment_id || null;
    const link = data?.result?.link || null;
    if (!r.ok || !paymentId || !link) {
      return json(res, { error: `Flouci HTTP ${r.status}${data?.message ? `: ${String(data.message).slice(0, 160)}` : ''}` }, 502);
    }
    await ctx.q('UPDATE public.orders SET payment_ref=$1, updated_at=now() WHERE id=$2', [String(paymentId), order_id]);
    return json(res, { paymentUrl: link, reference: paymentId, provider: 'flouci' });
  }

  if (integration.provider === 'stripe') {
    const key = creds.secret_key || '';
    if (!key) return json(res, { error: 'Configuration Stripe incomplète' }, 500);
    const form = new URLSearchParams({
      mode: 'payment',
      client_reference_id: order_id,
      'metadata[order_id]': order_id,
      'payment_intent_data[metadata][order_id]': order_id,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(Math.round(amountTnd * 100)),
      'line_items[0][price_data][product_data][name]': description,
      success_url: withParams(successUrl, { order: order_id, status: 'success' }),
      cancel_url: withParams(failUrl, { order: order_id, status: 'failed' }),
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id || !data.url) {
      return json(res, { error: `Stripe HTTP ${r.status}${data?.error?.message ? `: ${data.error.message}` : ''}` }, 502);
    }
    await ctx.q('UPDATE public.orders SET payment_ref=$1, updated_at=now() WHERE id=$2', [String(data.id), order_id]);
    return json(res, { paymentUrl: data.url, reference: data.id, provider: 'stripe' });
  }

  return json(res, { error: 'Provider non supporté' }, 400);
}
