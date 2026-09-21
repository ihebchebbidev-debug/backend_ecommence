// Port of supabase/functions/payment-callback/index.ts + providerVerify.ts
// (Konnect / Flouci / Paymee verification inlined.)
import crypto from 'node:crypto';
import { json } from './_shared/respond.js';

function log(event, data) {
  const safe = { event, timestamp: new Date().toISOString() };
  if (data) Object.assign(safe, data);
  console.log(JSON.stringify(safe));
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
function hmacSha256Hex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function fail(reason, providerStatus) {
  return { verified: false, providerStatus, providerAmountTnd: null, providerCurrency: null, providerReference: null, reason };
}

// ── Konnect ──────────────────────────────────────────────────────────────
async function verifyKonnect(payment, payload, headers) {
  const apiKey = process.env.KONNECT_API_KEY;
  const baseUrl = process.env.KONNECT_BASE_URL || 'https://api.konnect.network';

  const paymentRef = payload.payment_ref || payload.paymentRef || payload.id || payment.provider_payment_id;
  if (!paymentRef) return fail('missing_payment_reference', 'no_reference');

  const webhookSecret = process.env.KONNECT_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sigHeader = headers['x-konnect-signature'] || headers['signature'] || '';
    if (sigHeader) {
      const expectedSig = hmacSha256Hex(webhookSecret, JSON.stringify(payload));
      if (!timingSafeEqualStr(String(sigHeader), expectedSig)) return fail('signature_mismatch', 'invalid_signature');
    }
  }

  if (!apiKey) return fail('konnect_api_key_missing', 'demo');

  try {
    const r = await fetch(`${baseUrl}/api/v2/payments/${paymentRef}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return fail('provider_api_error', `http_${r.status}`);
    const data = await r.json();
    const p = data.payment || data;
    const status = String(p.status || '').toLowerCase();
    const isPaid = status === 'completed';
    const amountMillimes = Number(p.amount || p.amountDue || 0);
    const providerAmountTnd = amountMillimes / 1000;
    const providerCurrency = p.token || 'TND';
    const providerReference = p.id || paymentRef;

    if (!isPaid) return { verified: false, providerStatus: status, providerAmountTnd, providerCurrency, providerReference, reason: 'payment_not_paid' };
    return { verified: true, providerStatus: status, providerAmountTnd, providerCurrency, providerReference };
  } catch (err) {
    return fail(`provider_fetch_error: ${err.message}`, 'fetch_error');
  }
}

// ── Flouci ───────────────────────────────────────────────────────────────
async function verifyFlouci(payment, payload, headers) {
  const appToken = process.env.FLOUCI_APP_TOKEN;
  const appSecret = process.env.FLOUCI_APP_SECRET;
  const baseUrl = process.env.FLOUCI_BASE_URL || 'https://developers.flouci.com';

  const paymentId = payload.payment_id || payload.id || payment.provider_payment_id;
  if (!paymentId) return fail('missing_payment_reference', 'no_reference');

  const webhookSecret = process.env.FLOUCI_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sigHeader = headers['x-flouci-signature'] || headers['signature'] || '';
    if (sigHeader) {
      const expectedSig = hmacSha256Hex(webhookSecret, JSON.stringify(payload));
      if (!timingSafeEqualStr(String(sigHeader), expectedSig)) return fail('signature_mismatch', 'invalid_signature');
    }
  }

  if (!appToken || !appSecret) return fail('flouci_credentials_missing', 'demo');

  try {
    const r = await fetch(`${baseUrl}/api/v2/verify_payment/${paymentId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${appToken}:${appSecret}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return fail('provider_api_error', `http_${r.status}`);
    const data = await r.json();
    const success = data.success === true;
    const status = String(data.result?.status || '').toLowerCase();
    const isPaid = success && status === 'success';
    const amountMillimes = Number(data.result?.amount || 0);
    const providerAmountTnd = amountMillimes / 1000;
    const providerCurrency = 'TND';
    const providerReference = data.result?.order_number || paymentId;

    if (!isPaid) return { verified: false, providerStatus: status || String(data.success), providerAmountTnd, providerCurrency, providerReference, reason: 'payment_not_paid' };
    return { verified: true, providerStatus: status, providerAmountTnd, providerCurrency, providerReference };
  } catch (err) {
    return fail(`provider_fetch_error: ${err.message}`, 'fetch_error');
  }
}

// ── Paymee ───────────────────────────────────────────────────────────────
function verifyPaymee(payment, payload) {
  const apiKey = process.env.PAYMEE_API_KEY;
  const token = payload.token || payment.provider_payment_id;
  if (!token) return fail('missing_payment_reference', 'no_reference');
  if (!apiKey) return fail('paymee_api_key_missing', 'demo');

  const paymentStatusBool = payload.payment_status;
  const paymentStatusNum = paymentStatusBool === true ? 1 : 0;
  const expectedChecksum = md5hex(`${token}${paymentStatusNum}${apiKey}`);
  const receivedChecksum = payload.check_sum || '';

  if (!receivedChecksum) return fail('missing_check_sum', 'no_checksum');
  if (!timingSafeEqualStr(String(receivedChecksum), expectedChecksum)) return fail('checksum_mismatch', 'invalid_checksum');

  const isPaid = paymentStatusBool === true;
  const providerAmountTnd = Number(payload.amount || 0);
  const providerCurrency = 'TND';
  const providerReference = token;

  if (!isPaid) return { verified: false, providerStatus: 'failed', providerAmountTnd, providerCurrency, providerReference, reason: 'payment_not_paid' };
  return { verified: true, providerStatus: 'paid', providerAmountTnd, providerCurrency, providerReference };
}

async function verifyPaymentWithProvider(provider, payment, payload, headers) {
  const prov = (provider || '').toLowerCase();
  switch (prov) {
    case 'konnect':
    case 'bank_card':
      return verifyKonnect(payment, payload, headers);
    case 'flouci':
      return verifyFlouci(payment, payload, headers);
    case 'paymee':
      return verifyPaymee(payment, payload);
    case 'manual':
      return { verified: false, providerStatus: 'manual', providerAmountTnd: null, providerCurrency: null, providerReference: null, reason: 'manual_payments_require_admin_confirmation' };
    default:
      return { verified: false, providerStatus: 'unknown', providerAmountTnd: null, providerCurrency: null, providerReference: null, reason: `unsupported_provider:${prov}` };
  }
}

// ── Wallet top-up processing ──────────────────────────────────────────────
async function processWalletTopup(ctx, payment) {
  const store = await ctx.q('SELECT subscription_plan FROM public.platform_stores WHERE id=$1', [payment.store_id]).then((r) => r[0]);
  const planCode = store?.subscription_plan || 'starter';
  const isStarter = planCode === 'starter';

  const existingTxn = await ctx.q(
    "SELECT id FROM public.wallet_transactions WHERE payment_id=$1 AND type='topup'",
    [payment.id],
  ).then((r) => r[0]);
  if (existingTxn) {
    log('payment_callback_already_paid', { reason: 'topup_transaction_exists', payment_id: payment.id });
    return;
  }

  const wallet = await ctx.q('SELECT * FROM public.store_wallets WHERE store_id=$1', [payment.store_id]).then((r) => r[0]);

  if (isStarter) {
    if (wallet) {
      await ctx.q(
        'UPDATE public.store_wallets SET balance_tnd=$1, updated_at=now() WHERE id=$2',
        [Number(wallet.balance_tnd || 0) + Number(payment.amount_tnd), wallet.id],
      );
    } else {
      await ctx.q('INSERT INTO public.store_wallets (store_id, balance_tnd) VALUES ($1,$2)', [payment.store_id, Number(payment.amount_tnd)]);
    }

    await ctx.q(
      `INSERT INTO public.wallet_transactions
         (store_id, wallet_id, user_id, type, amount, amount_tnd, status, payment_id, description, metadata)
       VALUES ($1,$2,$3,'topup',$4,$5,'completed',$6,$7,$8)`,
      [
        payment.store_id, wallet?.id || null, payment.user_id, Number(payment.amount_tnd), Number(payment.amount_tnd),
        payment.id, 'Recharge solde Starter', JSON.stringify({ provider: payment.provider, provider_payment_id: payment.provider_payment_id }),
      ],
    );
  } else {
    if (wallet) {
      await ctx.q(
        'UPDATE public.store_wallets SET balance_usd=$1, updated_at=now() WHERE id=$2',
        [Number(wallet.balance_usd || 0) + Number(payment.amount_usd), wallet.id],
      );
    } else {
      await ctx.q('INSERT INTO public.store_wallets (store_id, balance_usd) VALUES ($1,$2)', [payment.store_id, Number(payment.amount_usd)]);
    }

    await ctx.q(
      `INSERT INTO public.wallet_transactions
         (store_id, wallet_id, user_id, type, amount, amount_usd, amount_tnd, exchange_rate, status, payment_id, description, metadata)
       VALUES ($1,$2,$3,'topup',$4,$5,$6,$7,'completed',$8,$9,$10)`,
      [
        payment.store_id, wallet?.id || null, payment.user_id, Number(payment.amount_usd), Number(payment.amount_usd),
        Number(payment.amount_tnd), Number(payment.exchange_rate), payment.id, 'Wallet top-up',
        JSON.stringify({ provider: payment.provider, provider_payment_id: payment.provider_payment_id }),
      ],
    );
  }
}

// ── Subscription payment processing ───────────────────────────────────────
async function processSubscriptionPayment(ctx, payment) {
  const sub = await ctx.q(
    'SELECT * FROM public.store_subscriptions WHERE store_id=$1 ORDER BY created_at DESC LIMIT 1',
    [payment.store_id],
  ).then((r) => r[0]);

  const now = new Date();
  let periodStart;
  let periodEnd;

  if (sub?.trial_ends_at && new Date(sub.trial_ends_at) > now) {
    periodStart = new Date(sub.trial_ends_at).toISOString();
    periodEnd = new Date(new Date(sub.trial_ends_at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  } else {
    periodStart = now.toISOString();
    periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (sub) {
    await ctx.q(
      `UPDATE public.store_subscriptions SET
         status='active', paid_at=$1, current_period_start=$2, current_period_end=$3,
         customer_data_locked=false, customer_data_locked_reason=null, customer_data_locked_at=null,
         updated_at=$1
       WHERE id=$4`,
      [now.toISOString(), periodStart, periodEnd, sub.id],
    );
  } else {
    const plan = await ctx.q('SELECT id FROM public.plans WHERE code=$1', [payment.plan_code]).then((r) => r[0]);
    await ctx.q(
      `INSERT INTO public.store_subscriptions
         (store_id, user_id, plan_id, status, paid_at, current_period_start, current_period_end)
       VALUES ($1,$2,$3,'active',$4,$5,$6)`,
      [payment.store_id, payment.user_id, plan?.id || null, now.toISOString(), periodStart, periodEnd],
    );
  }

  const existingInvoice = await ctx.q(
    'SELECT id, status FROM public.invoices WHERE payment_id=$1',
    [payment.id],
  ).then((r) => r[0]);

  const invoiceNumber = `INV-${Date.now()}-${String(payment.store_id).slice(0, 4)}`;

  if (existingInvoice) {
    if (existingInvoice.status !== 'paid') {
      await ctx.q('UPDATE public.invoices SET status=$1, paid_at=$2 WHERE id=$3', ['paid', now.toISOString(), existingInvoice.id]);
    }
  } else {
    await ctx.q(
      `INSERT INTO public.invoices
         (store_id, subscription_id, payment_id, invoice_number, amount_usd, display_currency,
          exchange_rate, amount_tnd, payment_currency, status, paid_at)
       VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,'TND','paid',$8)`,
      [
        payment.store_id, sub?.id || null, payment.id, invoiceNumber, Number(payment.amount_usd),
        Number(payment.exchange_rate), Number(payment.amount_tnd), now.toISOString(),
      ],
    );
  }
}

export default async function paymentCallback(req, res, ctx) {
  try {
    log('payment_callback_received', { method: req.method });

    let body = {};
    if (req.method === 'GET') {
      for (const [k, v] of Object.entries(req.query || {})) body[k] = v;
    } else {
      body = req.body || {};
      if (!body || typeof body !== 'object') {
        log('payment_callback_rejected', { reason: 'invalid_json_body' });
        return json(res, { error: 'Invalid JSON body' }, 400);
      }
    }

    const callbackPaymentId = body.orderId || body.payment_id || body.order_id || null;
    const callbackPaymentRef =
      body.payment_ref || body.paymentRef || body.id || body.transaction_id || body.reference || body.token || null;

    const callbackProvider = String(body.provider || body.provider_name || '').toLowerCase();
    if (callbackProvider === 'manual') {
      log('payment_callback_rejected', { reason: 'manual_payments_require_admin_confirmation' });
      return json(res, { error: 'Manual payments require admin confirmation' }, 403);
    }

    let payment;
    if (callbackPaymentId) {
      payment = await ctx.q('SELECT * FROM public.payments WHERE id=$1', [callbackPaymentId]).then((r) => r[0]);
    } else if (callbackPaymentRef) {
      payment = await ctx.q('SELECT * FROM public.payments WHERE provider_payment_id=$1', [String(callbackPaymentRef)]).then((r) => r[0]);
    } else {
      log('payment_callback_rejected', { reason: 'no_payment_identifier' });
      return json(res, { error: 'No payment identifier provided' }, 400);
    }

    if (!payment) {
      log('payment_callback_unknown_payment', { ref: callbackPaymentRef, id: callbackPaymentId });
      return json(res, { error: 'Payment not found' }, 404);
    }

    if (payment.status === 'paid') {
      log('payment_callback_already_paid', { payment_id: payment.id });
      return json(res, { message: 'Payment already processed' }, 200);
    }

    if (payment.status === 'failed' || payment.status === 'cancelled') {
      log('payment_callback_rejected', { reason: `payment_already_${payment.status}`, payment_id: payment.id });
      return json(res, { error: `Payment already ${payment.status}` }, 400);
    }

    if (payment.purpose !== 'wallet_topup' && payment.purpose !== 'subscription_payment') {
      log('payment_callback_rejected', { reason: 'invalid_purpose', purpose: payment.purpose });
      return json(res, { error: 'Invalid payment purpose' }, 400);
    }

    log('payment_callback_verification_started', { payment_id: payment.id, provider: payment.provider });

    const verifyResult = await verifyPaymentWithProvider(payment.provider, payment, body, req.headers);

    if (!verifyResult.verified) {
      log('payment_callback_rejected', { payment_id: payment.id, reason: verifyResult.reason, provider_status: verifyResult.providerStatus });
      return json(res, { error: 'Payment verification failed', reason: verifyResult.reason }, 400);
    }

    log('payment_callback_verified', { payment_id: payment.id, provider_status: verifyResult.providerStatus, provider_reference: verifyResult.providerReference });

    if (verifyResult.providerAmountTnd !== null) {
      const tolerance = 0.001;
      if (Math.abs(verifyResult.providerAmountTnd - Number(payment.amount_tnd)) > tolerance) {
        log('payment_callback_amount_mismatch', { payment_id: payment.id, expected: payment.amount_tnd, provider_amount: verifyResult.providerAmountTnd });
        return json(res, { error: 'Amount mismatch' }, 400);
      }
    }

    if (verifyResult.providerCurrency && verifyResult.providerCurrency !== 'TND') {
      log('payment_callback_amount_mismatch', { payment_id: payment.id, reason: 'currency_mismatch', provider_currency: verifyResult.providerCurrency });
      return json(res, { error: 'Currency mismatch' }, 400);
    }

    if (
      verifyResult.providerReference &&
      payment.provider_payment_id &&
      verifyResult.providerReference !== payment.provider_payment_id
    ) {
      log('payment_callback_rejected', {
        payment_id: payment.id, reason: 'reference_mismatch', expected: payment.provider_payment_id, got: verifyResult.providerReference,
      });
      return json(res, { error: 'Reference mismatch' }, 400);
    }

    const nowIso = new Date().toISOString();
    try {
      await ctx.q('UPDATE public.payments SET status=$1, paid_at=$2, updated_at=$2 WHERE id=$3', ['paid', nowIso, payment.id]);
    } catch {
      log('payment_callback_processing_error', { payment_id: payment.id, error: 'failed_to_mark_paid' });
      return json(res, { error: 'Failed to mark payment as paid' }, 500);
    }

    try {
      if (payment.purpose === 'wallet_topup') {
        await processWalletTopup(ctx, payment);
      } else if (payment.purpose === 'subscription_payment') {
        await processSubscriptionPayment(ctx, payment);
      }

      await ctx.q('UPDATE public.store_subscriptions SET customer_data_locked=false, customer_data_locked_at=now() WHERE store_id=$1', [payment.store_id]);

      log('payment_callback_processed_success', { payment_id: payment.id, purpose: payment.purpose });
      return json(res, { message: 'Payment processed successfully' }, 200);
    } catch (procErr) {
      log('payment_callback_processing_error', { payment_id: payment.id, error: procErr.message });
      return json(res, { error: 'Payment processed but post-processing failed' }, 500);
    }
  } catch (err) {
    log('payment_callback_processing_error', { error: err.message });
    return json(res, { error: err.message }, 500);
  }
}
