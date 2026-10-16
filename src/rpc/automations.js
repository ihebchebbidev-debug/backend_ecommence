// Seller message automations: list, save, delete, test, and whether the platform can send.
import { badRequest, forbidden } from '../lib/errors.js';
import { id, permission } from '../lib/commerce.js';
import { getMessagingSettings, smsReady, smtpReady } from '../lib/messaging.js';
import { canSendMail } from '../lib/mailer.js';
import { TRIGGERS, CHANNELS, sendAutomation, emailOk } from '../lib/storeAutomations.js';
import { normalizePhone } from '../auth/otp.js';

const PERM = 'canManageAutomations';
const MAX_PER_STORE = 50;

function definition(v) {
  if (!v || typeof v !== 'object') throw badRequest('Automatisation invalide');
  const name = String(v.name || '').trim().slice(0, 120);
  const message = String(v.message || '').trim().slice(0, 1600);
  const delay = Number(v.delay_minutes ?? 0);
  if (!name) throw badRequest('Nom requis');
  if (!message) throw badRequest('Message requis');
  if (!TRIGGERS.includes(v.trigger_event)) throw badRequest('Déclencheur invalide');
  if (!CHANNELS.includes(v.channel)) throw badRequest('Canal invalide');
  if (!Number.isInteger(delay) || delay < 0 || delay > 10080) throw badRequest('Délai invalide (0 à 10080 minutes)');
  const email_to = String(v.email_to || '').trim().slice(0, 200);
  if (v.channel === 'email' && !emailOk(email_to)) throw badRequest('Adresse email du destinataire invalide');
  return { name, message, trigger_event: v.trigger_event, channel: v.channel, delay_minutes: delay, email_to, subject: String(v.subject || '').trim().slice(0, 200), active: v.active === true };
}

async function channelStatus() {
  const s = await getMessagingSettings();
  return { sms_ready: smsReady(s), email_ready: smtpReady(s) || canSendMail() };
}

export default {
  async store_automations_list({ p_store_id }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const rows = await ctx.q('SELECT * FROM public.store_automations WHERE store_id=$1 ORDER BY created_at', [p_store_id]);
    const pending = await ctx.one('SELECT count(*)::int AS n FROM public.store_automation_runs WHERE store_id=$1 AND sent_at IS NULL AND skipped IS NULL', [p_store_id]);
    return { automations: rows, pending: pending?.n ?? 0, ...(await channelStatus()) };
  },

  async store_automation_save({ p_store_id, p_id = null, p_automation }, ctx) {
    await permission(ctx, p_store_id, PERM);
    const d = definition(p_automation);
    const vals = [p_store_id, d.name, d.trigger_event, d.channel, d.message, d.subject, d.email_to, d.delay_minutes, d.active];
    if (p_id) {
      const row = await ctx.one(`UPDATE public.store_automations SET name=$2, trigger_event=$3, channel=$4, message=$5, subject=$6, email_to=$7, delay_minutes=$8, active=$9, updated_at=now()
        WHERE id=$10 AND store_id=$1 RETURNING *`, [...vals, id(p_id)]);
      if (!row) throw forbidden('Automatisation introuvable');
      return row;
    }
    const c = await ctx.one('SELECT count(*)::int AS n FROM public.store_automations WHERE store_id=$1', [p_store_id]);
    if ((c?.n ?? 0) >= MAX_PER_STORE) throw badRequest(`Maximum ${MAX_PER_STORE} automatisations par boutique`);
    return ctx.one(`INSERT INTO public.store_automations(store_id, name, trigger_event, channel, message, subject, email_to, delay_minutes, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, vals);
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
    const shop = await ctx.one('SELECT store_name FROM public.platform_stores WHERE id=$1', [p_store_id]);
    const sample = { client_name: 'Sarra Ben Ali', client_phone: p_to, order_number: 1042, amount: 120, delivery_fee: 7, currency: 'TND', product_name: 'Produit exemple', quantity: 1, city: 'Tunis', tracking_number: 'TN123456' };
    try {
      const res = await sendAutomation(d, sample, shop?.store_name || '', await getMessagingSettings());
      if (res.skipped === 'sms_not_configured') return { ok: false, error: "L'envoi de SMS n'est pas encore activé sur la plateforme." };
      return res.sent ? { ok: true } : { ok: false, error: res.skipped };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  },
};
