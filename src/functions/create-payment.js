// Port of supabase/functions/create-payment/index.ts
import { json } from './_shared/respond.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000002';

export default async function createPayment(req, res, ctx) {
  try {
    if (!ctx.userId) return json(res, { error: 'Unauthorized' }, 401);

    const profile = await ctx.q(
      'SELECT status, deleted_at, full_name, email FROM public.profiles WHERE id=$1',
      [ctx.userId],
    ).then((r) => r[0]);
    if (profile?.deleted_at || (profile?.status && profile.status !== 'active')) {
      return json(res, { error: 'Account suspended or deleted' }, 403);
    }

    const body = req.body || {};
    const { store_id, purpose, successUrl, failUrl } = body;
    const provider = body.provider || 'konnect';

    if (!store_id) return json(res, { error: 'store_id is required' }, 400);

    const membership = await ctx.q(
      "SELECT role, status FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND status='active'",
      [store_id, ctx.userId],
    ).then((r) => r[0]);
    const isSuperAdmin = await ctx.isSuperAdmin();
    if (!membership && !isSuperAdmin) return json(res, { error: 'Not authorized for this store' }, 403);

    const store = await ctx.q('SELECT id, status, subscription_plan FROM public.platform_stores WHERE id=$1', [store_id]).then((r) => r[0]);
    if (!store) return json(res, { error: 'Store not found' }, 404);

    const planCode = store.subscription_plan || 'starter';
    const isStarter = planCode === 'starter';

    let amountUsd = 0;
    let amountTnd = 0;
    let planCodeForPayment = null;
    let description = '';
    let paymentCurrency = 'TND';
    let displayCurrency = 'USD';
    let exchangeRate = 1;

    async function getUsdToTndRate() {
      const row = await ctx.q(
        `SELECT rate FROM public.currency_rates
          WHERE is_active = true AND base_currency = 'USD' AND target_currency = 'TND'
          ORDER BY updated_at DESC LIMIT 1`,
      ).then((r) => r[0]);
      return row ? Number(row.rate) : null;
    }

    if (purpose === 'wallet_topup') {
      if (isStarter) {
        amountTnd = Number(body.amount_tnd) || 0;
        if (!amountTnd || amountTnd <= 0) return json(res, { error: 'Invalid amount' }, 400);
        if (amountTnd < 5 || amountTnd > 5000) return json(res, { error: 'Amount must be between 5 and 5000 TND' }, 400);
        amountUsd = 0;
        displayCurrency = 'TND';
        paymentCurrency = 'TND';
        exchangeRate = 1;
        description = `Recharge solde Starter — ${amountTnd} TND`;
      } else {
        amountUsd = Number(body.amount_usd) || 0;
        if (!amountUsd || amountUsd <= 0) return json(res, { error: 'Invalid amount' }, 400);
        if (amountUsd < 5 || amountUsd > 3000) return json(res, { error: 'Amount must be between 5 and 3000 USD' }, 400);

        const rate = await getUsdToTndRate();
        if (!rate) return json(res, { error: 'Exchange rate not configured' }, 500);

        exchangeRate = rate;
        amountTnd = Math.round(amountUsd * exchangeRate * 1000) / 1000;
        description = `Wallet top-up — ${amountUsd} USD`;
      }
    } else if (purpose === 'subscription_payment') {
      planCodeForPayment = body.plan_code || '';
      if (!planCodeForPayment) return json(res, { error: 'plan_code is required for subscription' }, 400);

      const plan = await ctx.q(
        'SELECT price_usd, name FROM public.plans WHERE code=$1 AND is_active=true',
        [planCodeForPayment],
      ).then((r) => r[0]);
      if (!plan) return json(res, { error: 'Plan not found or inactive' }, 400);

      amountUsd = Number(plan.price_usd);
      if (amountUsd <= 0) return json(res, { error: 'This plan has no payment required' }, 400);

      const rate = await getUsdToTndRate();
      if (!rate) return json(res, { error: 'Exchange rate not configured' }, 500);

      exchangeRate = rate;
      amountTnd = Math.round(amountUsd * exchangeRate * 1000) / 1000;
      description = `Subscription — ${plan.name}`;
    } else {
      return json(res, { error: 'Invalid purpose' }, 400);
    }

    const payment = await ctx.one(
      `INSERT INTO public.payments
         (store_id, user_id, provider, purpose, plan_code, amount_usd, display_currency,
          exchange_rate, amount_tnd, payment_currency, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
       RETURNING id`,
      [
        store_id, ctx.userId, provider, purpose, planCodeForPayment, amountUsd, displayCurrency,
        exchangeRate, amountTnd, paymentCurrency,
        JSON.stringify({ description, plan_code: planCode }),
      ],
    );

    if (!payment) return json(res, { error: 'Failed to create payment record' }, 500);

    const gwSettings = await ctx.q(
      'SELECT provider, api_key, wallet_id, environment FROM public.payment_gateway_settings WHERE id=$1',
      [SETTINGS_ID],
    ).then((r) => r[0]);

    const konnectApiKey = gwSettings?.api_key || process.env.KONNECT_API_KEY;
    const konnectWalletId = gwSettings?.wallet_id || process.env.KONNECT_WALLET_ID || '';

    if (konnectApiKey) {
      try {
        const fullName = profile?.full_name || '';
        const konnectRes = await fetch('https://api.konnect.network/api/v2/payments/init-payment', {
          method: 'POST',
          headers: { 'x-api-key': konnectApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            receiverWalletId: konnectWalletId,
            token: 'TND',
            amount: Math.round(amountTnd * 1000),
            type: 'immediate',
            description,
            acceptedPaymentMethods: ['wallet', 'bank_card', 'e-DINAR'],
            lifespan: 30,
            checkoutForm: true,
            addPaymentFeesToAmount: true,
            firstName: fullName.split(' ')[0] || '',
            lastName: fullName.split(' ').slice(1).join(' ') || '',
            email: profile?.email || '',
            orderId: payment.id,
            webhook: `${process.env.PUBLIC_FUNCTIONS_BASE_URL || ''}/functions/v1/payment-callback`,
            successUrl: `${successUrl}?payment=${payment.id}&status=success`,
            failUrl: `${failUrl}?payment=${payment.id}&status=failed`,
            theme: 'dark',
          }),
        });

        if (konnectRes.ok) {
          const konnectData = await konnectRes.json();
          await ctx.q(
            'UPDATE public.payments SET provider_payment_id=$1, provider_payment_url=$2 WHERE id=$3',
            [konnectData.paymentRef, konnectData.payUrl, payment.id],
          );

          return json(res, {
            paymentId: payment.id,
            paymentUrl: konnectData.payUrl,
            reference: konnectData.paymentRef,
            amountUsd,
            amountTnd,
            exchangeRate,
            isStarter,
          });
        }
      } catch {
        // fall through to demo mode
      }
    }

    const demoRef = `DEMO-${Date.now()}`;
    await ctx.q('UPDATE public.payments SET provider_payment_id=$1 WHERE id=$2', [demoRef, payment.id]);

    return json(res, {
      paymentId: payment.id,
      paymentUrl: null,
      reference: demoRef,
      demo: true,
      amountUsd,
      amountTnd,
      exchangeRate,
      isStarter,
    });
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
}
