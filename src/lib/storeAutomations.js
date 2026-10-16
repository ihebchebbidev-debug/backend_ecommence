// Sends due seller automations: SMS to the order's customer, email to the seller,
// through the platform SMS / SMTP settings configured by the super admin.
import { getMessagingSettings, smsReady, sendSms } from './messaging.js';
import { sendMail } from './mailer.js';
import { normalizePhone } from '../auth/otp.js';

export const TRIGGERS = ['order_created', 'order_confirmed', 'order_shipped', 'order_delivered', 'order_cancelled', 'order_returned', 'payment_failed'];
export const CHANNELS = ['sms', 'email'];
export const MAX_ATTEMPTS = 5;

/** Fill {prenom} {nom} {numero} {montant} {produit} {quantite} {ville} {suivi} {boutique}. */
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
    ville: order.city || '',
    suivi: order.tracking_number || '',
    lien_suivi: order.tracking_number || '',
    boutique: shopName || '',
  };
  return String(text || '').replace(/\{([a-z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)).trim();
}

export const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));

/** Sends one automation for one order; returns { sent } or { skipped }. Throws on provider errors. */
export async function sendAutomation(a, order, shopName, settings) {
  const body = renderTemplate(a.message, order, shopName);
  if (!body) return { skipped: 'empty_message' };
  if (a.channel === 'sms') {
    if (!smsReady(settings)) return { skipped: 'sms_not_configured' };
    const to = normalizePhone(order.client_phone);
    if (!to) return { skipped: 'invalid_phone' };
    await sendSms(settings, to, body.slice(0, 1600));
    return { sent: true };
  }
  if (!emailOk(a.email_to)) return { skipped: 'invalid_email' };
  const subject = renderTemplate(a.subject || a.name, order, shopName).slice(0, 200) || a.name;
  const html = `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.5">${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</div>`;
  await sendMail({ to: a.email_to, subject, html, text: body });
  return { sent: true };
}

export async function processDueRuns(q, log) {
  const runs = await q(`SELECT r.id, r.attempts, r.order_id, a.id AS automation_id, a.name, a.channel, a.message, a.subject, a.email_to, a.trigger_event, a.active,
      o.client_name, o.client_phone, o.order_number, o.amount, o.delivery_fee, o.currency, o.product_name, o.quantity, o.city, o.tracking_number, o.status, o.deleted_at,
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
    let skipped = null;
    if (!r.active) skipped = 'automation_paused';
    else if (r.order_number == null || r.deleted_at) skipped = 'order_deleted';
    // A delayed message must not go out once the order was cancelled meanwhile.
    else if (r.trigger_event !== 'order_cancelled' && ['cancelled', 'canceled'].includes(r.status)) skipped = 'order_cancelled';
    try {
      const res = skipped ? { skipped } : await sendAutomation(r, r, r.shop_name, settings);
      if (res.sent) {
        await q('UPDATE public.store_automation_runs SET sent_at=now(), attempts=attempts+1, error=NULL WHERE id=$1', [r.id]);
        await q('UPDATE public.store_automations SET runs=runs+1, last_run_at=now(), last_error=NULL WHERE id=$1', [r.automation_id]);
      } else {
        await q('UPDATE public.store_automation_runs SET skipped=$2 WHERE id=$1', [r.id, res.skipped]);
        if (res.skipped !== 'automation_paused') await q('UPDATE public.store_automations SET last_error=$2 WHERE id=$1', [r.automation_id, res.skipped]);
      }
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      const attempts = r.attempts + 1;
      await q(`UPDATE public.store_automation_runs SET attempts=$2, error=$3, send_at=now() + make_interval(secs => $4) WHERE id=$1`, [r.id, attempts, msg, Math.min(3600, 60 * 2 ** attempts)]);
      await q('UPDATE public.store_automations SET last_error=$2 WHERE id=$1', [r.automation_id, msg]);
      log?.warn?.('store automation send failed', { run: r.id, message: msg });
    }
  }
  await q(`DELETE FROM public.store_automation_runs WHERE created_at < now() - interval '30 days'`);
}
