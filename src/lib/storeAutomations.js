// Sends due seller automations: SMS / email to the customer, email to the seller, or a
// Zapier/Make webhook, through the platform SMS / SMTP settings configured by the super admin.
// Automations can be filtered by conditions and continue with follow-up steps.
import { smsReady, sendSms, getMessagingSettings } from './messaging.js';
import { sendMail } from './mailer.js';
import { normalizePhone } from '../auth/otp.js';
import { validWebhookUrl, postWebhook } from './automationWebhooks.js';

export const TRIGGERS = ['order_created', 'order_confirmed', 'order_shipped', 'order_in_transit', 'order_delivered', 'order_cancelled', 'order_returned', 'order_rejected', 'order_attempt1', 'order_attempt2', 'payment_received', 'payment_failed'];
export const CHANNELS = ['sms', 'email', 'email_customer', 'webhook'];
export const MAX_ATTEMPTS = 5;
export const MAX_STEPS = 4;

/** Fill {prenom} {nom} {numero} {montant} {produit} {quantite} {ville} {suivi} {boutique} {telephone}. */
export function renderTemplate(text, order = {}, shopName = '') {
  const parts = String(order.client_name || '').trim().split(/\s+/);
  const amount = Number(order.amount || 0) + Number(order.delivery_fee || 0);
  const vars = {
    prenom: parts[0] || '',
    nom: parts.slice(1).join(' ') || parts[0] || '',
    numero: order.order_number ?? '',
    montant: `${Math.round(amount * 100) / 100} ${order.currency || 'TND'}`,
    produit: order.product_name || '',
    quantite: order.quantity ?? '',
    ville: order.city || order.region || '',
    suivi: order.tracking_number || '',
    lien_suivi: order.tracking_number || '',
    telephone: order.client_phone || '',
    boutique: shopName || '',
  };
  return String(text || '').replace(/\{([a-z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)).trim();
}

export const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
export const webhookOk = (url) => validWebhookUrl('zapier', url) || validWebhookUrl('make', url);

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Cleans seller-entered conditions; unknown keys are dropped. */
export function cleanConditions(c) {
  const v = c && typeof c === 'object' ? c : {};
  const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) || Number(x) < 0 ? null : Number(x));
  const list = (x) => (Array.isArray(x) ? x : String(x || '').split(',')).map((s) => String(s).trim()).filter(Boolean).slice(0, 30).map((s) => s.slice(0, 80));
  const out = {};
  const min = num(v.min_amount), max = num(v.max_amount);
  if (min != null) out.min_amount = min;
  if (max != null) out.max_amount = max;
  const regions = list(v.regions); if (regions.length) out.regions = regions;
  const products = list(v.products); if (products.length) out.products = products;
  if (['cod', 'online'].includes(v.payment)) out.payment = v.payment;
  if (['first', 'returning'].includes(v.customer)) out.customer = v.customer;
  return out;
}

/** Returns null when the order passes every condition, otherwise the reason it was skipped. */
export function conditionMiss(cond = {}, order = {}) {
  const total = Number(order.amount || 0) + Number(order.delivery_fee || 0);
  if (cond.min_amount != null && total < cond.min_amount) return 'condition_amount';
  if (cond.max_amount != null && total > cond.max_amount) return 'condition_amount';
  if (cond.regions?.length) {
    const place = norm(`${order.region || ''} ${order.city || ''}`);
    if (!cond.regions.some((r) => place.includes(norm(r)))) return 'condition_region';
  }
  if (cond.products?.length) {
    const p = norm(order.product_name);
    if (!cond.products.some((x) => p.includes(norm(x)))) return 'condition_product';
  }
  if (cond.payment) {
    const online = !!order.payment_provider && order.payment_provider !== 'cod';
    if ((cond.payment === 'online') !== online) return 'condition_payment';
  }
  if (cond.customer) {
    const first = Number(order.previous_orders || 0) === 0;
    if ((cond.customer === 'first') !== first) return 'condition_customer';
  }
  return null;
}

/** The message definition for a step: 0 = the automation itself, k = steps[k-1]. */
export function stepDefinition(a, index = 0) {
  if (!index) return a;
  const s = (Array.isArray(a.steps) ? a.steps : [])[index - 1];
  return s ? { ...s, name: a.name } : null;
}

/** Sends one message for one order; returns { sent } or { skipped }. Throws on provider errors. */
export async function sendAutomation(a, order, shopName, settings) {
  if (a.channel === 'webhook') {
    if (!webhookOk(a.webhook_url)) return { skipped: 'invalid_webhook' };
    const res = await postWebhook(a.webhook_url, { event: a.trigger_event || 'automation', automation: a.name, shop: shopName, order: {
      id: order.id || order.order_id, order_number: order.order_number, client_name: order.client_name, client_phone: order.client_phone,
      amount: order.amount, delivery_fee: order.delivery_fee, currency: order.currency, product_name: order.product_name, quantity: order.quantity,
      city: order.city, region: order.region, status: order.status, tracking_number: order.tracking_number } });
    if (!res.ok) throw new Error(res.error || `Webhook HTTP ${res.status}`);
    return { sent: true };
  }
  const body = renderTemplate(a.message, order, shopName);
  if (!body) return { skipped: 'empty_message' };
  if (a.channel === 'sms') {
    if (!smsReady(settings)) return { skipped: 'sms_not_configured' };
    const to = normalizePhone(order.client_phone);
    if (!to) return { skipped: 'invalid_phone' };
    await sendSms(settings, to, body.slice(0, 1600));
    return { sent: true };
  }
  const to = a.channel === 'email_customer' ? order.client_email : a.email_to;
  if (!emailOk(to)) return { skipped: a.channel === 'email_customer' ? 'no_customer_email' : 'invalid_email' };
  const subject = renderTemplate(a.subject || a.name, order, shopName).slice(0, 200) || a.name;
  const html = `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.5">${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</div>`;
  await sendMail({ to, subject, html, text: body });
  return { sent: true };
}

export async function processDueRuns(q, log) {
  const runs = await q(`SELECT r.id, r.attempts, r.order_id, r.step_index, r.definition, a.id AS automation_id, a.name, a.channel, a.message, a.subject, a.email_to, a.webhook_url,
      a.trigger_event, a.active, a.conditions, a.steps,
      o.client_name, o.client_phone, o.order_number, o.amount, o.delivery_fee, o.currency, o.product_name, o.quantity, o.city, o.region,
      o.tracking_number, o.status, o.deleted_at, o.payment_provider,
      (SELECT c.email FROM public.clients c WHERE c.id = o.client_id) AS client_email,
      (SELECT count(*)::int FROM public.orders p WHERE p.store_id = o.store_id AND p.client_phone = o.client_phone AND p.id <> o.id AND p.created_at < o.created_at AND p.deleted_at IS NULL) AS previous_orders,
      s.store_name AS shop_name
    FROM public.store_automation_runs r
    JOIN public.store_automations a ON a.id = r.automation_id
    LEFT JOIN public.orders o ON o.id = r.order_id
    LEFT JOIN public.platform_stores s ON s.id = r.store_id
    WHERE r.sent_at IS NULL AND r.skipped IS NULL AND r.send_at <= now() AND r.attempts < $1
    ORDER BY r.send_at LIMIT 50`, [MAX_ATTEMPTS]);
  if (!runs.length) return;
  const settings = await getMessagingSettings();
  for (const r of runs) {
    const def = r.definition || stepDefinition(r, r.step_index || 0);
    let skipped = null;
    if (!r.active) skipped = 'automation_paused';
    else if (!def) skipped = 'step_removed';
    else if (r.order_number == null || r.deleted_at) skipped = 'order_deleted';
    // A delayed message must not go out once the order was cancelled meanwhile.
    else if (r.trigger_event !== 'order_cancelled' && ['cancelled', 'canceled'].includes(r.status)) skipped = 'order_cancelled';
    else skipped = conditionMiss(r.conditions || {}, r);
    try {
      const res = skipped ? { skipped } : await sendAutomation({ ...def, trigger_event: r.trigger_event }, r, r.shop_name, settings);
      if (res.sent) {
        await q('UPDATE public.store_automation_runs SET sent_at=now(), attempts=attempts+1, error=NULL WHERE id=$1', [r.id]);
        await q('UPDATE public.store_automations SET runs=runs+1, last_run_at=now(), last_error=NULL WHERE id=$1', [r.automation_id]);
      } else {
        await q('UPDATE public.store_automation_runs SET skipped=$2 WHERE id=$1', [r.id, res.skipped]);
        const quiet = res.skipped === 'automation_paused' || String(res.skipped).startsWith('condition_') || res.skipped === 'step_removed';
        if (!quiet) await q('UPDATE public.store_automations SET last_error=$2 WHERE id=$1', [r.automation_id, res.skipped]);
      }
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      const attempts = r.attempts + 1;
      await q(`UPDATE public.store_automation_runs SET attempts=$2, error=$3, send_at=now() + make_interval(secs => $4) WHERE id=$1`, [r.id, attempts, msg, Math.min(3600, 60 * 2 ** attempts)]);
      await q('UPDATE public.store_automations SET last_error=$2 WHERE id=$1', [r.automation_id, msg]);
      log?.warn?.('store automation send failed', { run: r.id, message: msg });
    }
  }
  await q(`DELETE FROM public.store_automation_runs WHERE created_at < now() - interval '30 days'
    AND (sent_at IS NOT NULL OR skipped IS NOT NULL OR attempts >= $1)
    AND NOT EXISTS(SELECT 1 FROM public.store_automation_runs pending
      WHERE pending.automation_id=store_automation_runs.automation_id AND pending.order_id=store_automation_runs.order_id
      AND pending.sent_at IS NULL AND pending.skipped IS NULL AND pending.attempts < $1)`, [MAX_ATTEMPTS]);
}
