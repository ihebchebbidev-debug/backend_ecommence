// Port of supabase/functions/create-store-payment/index.ts (anon storefront checkout)
import { json, methodGuard } from './_shared/respond.js';

import { decryptPaymentJson } from './_shared/paymentCrypto.js';

export default async function createStorePayment(req, res, ctx) {
  if (methodGuard(req, res)) return;
  const { order_id, store_id, successUrl, failUrl } = req.body || {};
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
    'SELECT id, provider, credentials_encrypted, credentials_iv, credentials_version, is_active, connection_status FROM public.store_payment_integrations WHERE store_id=$1 AND is_active=true',
    [store_id],
  ).then((r) => r[0]);
  if (!integration || !integration.is_active || integration.connection_status !== 'connected') {
    return json(res, { error: 'Aucune passerelle de paiement active pour ce magasin' }, 409);
  }
  if (!integration.credentials_encrypted || !integration.credentials_iv) {
    return json(res, { error: 'Identifiants de paiement manquants' }, 500);
  }

  // Gateways only charge the currencies they support; never relabel a USD order as TND.
  const currency = String(order.currency || 'TND').trim().toUpperCase();
  const supported = integration.provider === 'konnect' ? ['TND', 'EUR', 'USD'] : ['TND'];
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

  const webhook = `${process.env.PUBLIC_FUNCTIONS_BASE_URL || ''}/functions/v1/store-payment-callback`;
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

  return json(res, { error: 'Provider non supporté' }, 400);
}
