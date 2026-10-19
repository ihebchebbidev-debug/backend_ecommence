// Seller message automations: list, save, delete, test, and whether the platform can send.
import { badRequest, forbidden } from '../lib/errors.js';
import { id, permission } from '../lib/commerce.js';
import { getMessagingSettings, smsReady, smtpReady } from '../lib/messaging.js';
import { canSendMail } from '../lib/mailer.js';
import { TRIGGERS, CHANNELS, MAX_ATTEMPTS, MAX_STEPS, sendAutomation, emailOk, webhookOk, cleanConditions } from '../lib/storeAutomations.js';
import { normalizePhone } from '../auth/otp.js';

const PERM = 'canManageAutomations';
const MAX_PER_STORE = 50;

function message(v, label = '') {
  const channel = v.channel;
  if (!CHANNELS.includes(channel)) throw badRequest(`${label}Canal invalide`);
  const msg = String(v.message || '').trim().slice(0, 1600);
  if (channel !== 'webhook' && !msg) throw badRequest(`${label}Message requis`);
  const email_to = String(v.email_to || '').trim().slice(0, 200);
  if (channel === 'email' && !emailOk(email_to)) throw badRequest(`${label}Adresse email du destinataire invalide`);
  const webhook_url = String(v.webhook_url || '').trim().slice(0, 500);
  if (channel === 'webhook' && !webhookOk(webhook_url)) throw badRequest(`${label}Lien webhook invalide (Zapier ou Make en https uniquement)`);
  const delay = Number(v.delay_minutes ?? 0);
  if (!Number.isInteger(delay) || delay < 0 || delay > 10080) throw badRequest(`${label}Délai invalide (0 à 10080 minutes)`);
  return { channel, message: msg, subject: String(v.subject || '').trim().slice(0, 200), email_to, webhook_url, delay_minutes: delay };
}

export function definition(v) {
  if (!v || typeof v !== 'object') throw badRequest('Automatisation invalide');
  const name = String(v.name || '').trim().slice(0, 120);
  if (!name) throw badRequest('Nom requis');
  if (!TRIGGERS.includes(v.trigger_event)) throw badRequest('Déclencheur invalide');
  const steps = Array.isArray(v.steps) ? v.steps : [];
  if (steps.length > MAX_STEPS) throw badRequest(`Maximum ${MAX_STEPS} étapes de suivi`);
  return {
    name, trigger_event: v.trigger_event, active: v.active === true, ...message(v),
    conditions: cleanConditions(v.conditions),
    steps: steps.map((s, i) => message(s || {}, `Étape ${i + 2} : `)),
  };
}

async function channelStatus() {
  const s = await getMessagingSettings();
  return { sms_ready: smsReady(s), email_ready: smtpReady(s) || canSendMail() };
}

export default {
  async store_automations_list({ p_store_id }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const rows = await ctx.q(`SELECT a.*,
        (SELECT count(*)::int FROM public.store_automation_runs r WHERE r.automation_id=a.id AND r.sent_at IS NOT NULL) AS sent_30d,
        (SELECT count(*)::int FROM public.store_automation_runs r WHERE r.automation_id=a.id AND r.skipped IS NOT NULL) AS skipped_30d,
        (SELECT count(*)::int FROM public.store_automation_runs r WHERE r.automation_id=a.id AND r.sent_at IS NULL AND r.skipped IS NULL AND r.attempts >= $2) AS failed_30d,
        (SELECT count(*)::int FROM public.store_automation_runs r WHERE r.automation_id=a.id AND r.sent_at IS NULL AND r.skipped IS NULL AND r.attempts < $2) AS pending
      FROM public.store_automations a WHERE a.store_id=$1 ORDER BY a.created_at`, [p_store_id, MAX_ATTEMPTS]);
    const pending = await ctx.one('SELECT count(*)::int AS n FROM public.store_automation_runs WHERE store_id=$1 AND sent_at IS NULL AND skipped IS NULL AND attempts < $2', [p_store_id, MAX_ATTEMPTS]);
    return { automations: rows, pending: pending?.n ?? 0, ...(await channelStatus()) };
  },

  async store_automation_save({ p_store_id, p_id = null, p_automation }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const d = definition(p_automation);
    const vals = [p_store_id, d.name, d.trigger_event, d.channel, d.message, d.subject, d.email_to, d.delay_minutes, d.active, d.webhook_url, JSON.stringify(d.conditions), JSON.stringify(d.steps)];
    if (p_id) {
      const row = await ctx.one(`UPDATE public.store_automations SET name=$2, trigger_event=$3, channel=$4, message=$5, subject=$6, email_to=$7, delay_minutes=$8, active=$9,
        webhook_url=$10, conditions=$11::jsonb, steps=$12::jsonb, updated_at=now()
        WHERE id=$13 AND store_id=$1 RETURNING *`, [...vals, id(p_id)]);
      if (!row) throw forbidden('Automatisation introuvable');
      return row;
    }
    const c = await ctx.one('SELECT count(*)::int AS n FROM public.store_automations WHERE store_id=$1', [p_store_id]);
    if ((c?.n ?? 0) >= MAX_PER_STORE) throw badRequest(`Maximum ${MAX_PER_STORE} automatisations par boutique`);
    return ctx.one(`INSERT INTO public.store_automations(store_id, name, trigger_event, channel, message, subject, email_to, delay_minutes, active, webhook_url, conditions, steps)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) RETURNING *`, vals);
  },

  /** Last 30 days of sends for the shop (or one automation): sent, skipped, failed or waiting. */
  async store_automation_history({ p_store_id, p_automation_id = null }, ctx) {
    await permission(ctx, p_store_id, PERM);
    return ctx.q(`SELECT r.id, r.automation_id, a.name AS automation_name, r.step_index, r.send_at, r.sent_at, r.skipped, r.error, r.attempts,
        o.order_number, o.client_name,
        CASE WHEN r.sent_at IS NOT NULL THEN 'sent' WHEN r.skipped IS NOT NULL THEN 'skipped' WHEN r.attempts >= $3 THEN 'failed' ELSE 'pending' END AS state,
        CASE WHEN r.step_index = 0 THEN a.channel ELSE a.steps->(r.step_index - 1)->>'channel' END AS channel
      FROM public.store_automation_runs r
      JOIN public.store_automations a ON a.id = r.automation_id
      LEFT JOIN public.orders o ON o.id = r.order_id
      WHERE r.store_id=$1 AND ($2::uuid IS NULL OR r.automation_id=$2::uuid)
      ORDER BY COALESCE(r.sent_at, r.send_at) DESC LIMIT 200`, [p_store_id, p_automation_id ? id(p_automation_id) : null, MAX_ATTEMPTS]);
  },

  async store_automation_delete({ p_store_id, p_id }, ctx) {
    await permission(ctx, p_store_id, PERM);
    await ctx.q('DELETE FROM public.store_automations WHERE id=$1 AND store_id=$2', [id(p_id), p_store_id]);
    return null;
  },

  /** Sends the message once with sample order data to a phone or email the seller types. */
  async store_automation_test({ p_store_id, p_automation, p_to }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const d = definition({ ...p_automation, email_to: p_automation?.channel === 'email' ? p_to : 'x@x.xx' });
    if (d.channel === 'sms' && !normalizePhone(p_to)) return { ok: false, error: 'Numéro invalide (format +216XXXXXXXX)' };
    if (d.channel === 'email_customer' && !emailOk(p_to)) return { ok: false, error: 'Adresse email invalide' };
    const shop = await ctx.one('SELECT store_name FROM public.platform_stores WHERE id=$1', [p_store_id]);
    const sample = { client_name: 'Sarra Ben Ali', client_phone: p_to, order_number: 1042, amount: 120, delivery_fee: 7, currency: 'TND', product_name: 'Produit exemple', quantity: 1, city: 'Tunis', tracking_number: 'TN123456', client_email: p_to, id: 'test', status: 'confirmed' };
    try {
      const res = await sendAutomation(d, sample, shop?.store_name || '', await getMessagingSettings());
      if (res.skipped === 'sms_not_configured') return { ok: false, error: "L'envoi de SMS n'est pas encore activé sur la plateforme." };
      return res.sent ? { ok: true } : { ok: false, error: res.skipped };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  },
};
