// Platform messaging: admin-configured SMTP email + SMS providers.
// Settings live in the private `platform_messaging_settings` singleton row.
import nodemailer from 'nodemailer';
import { one } from '../db.js';
import { createLogger } from './logger.js';

const log = createLogger('messaging');

export const SMTP_PRESETS = {
  godaddy: { host: 'smtp.office365.com', port: 587, secure: false },
  godaddy_legacy: { host: 'smtpout.secureserver.net', port: 465, secure: true },
  ovh: { host: 'ssl0.ovh.net', port: 465, secure: true },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  office365: { host: 'smtp.office365.com', port: 587, secure: false },
  custom: null,
};
export const SMS_PROVIDERS = ['twilio', 'vonage', 'infobip', 'custom'];
export const SECRET_FIELDS = ['smtp_pass', 'sms_secret'];

let cache = null;
let cacheAt = 0;
export function invalidateMessagingSettings() { cache = null; }

export async function getMessagingSettings() {
  if (cache && Date.now() - cacheAt < 30_000) return cache;
  const row = await one('SELECT * FROM public.platform_messaging_settings WHERE id = 1').catch(() => null);
  cache = row || {};
  cacheAt = Date.now();
  return cache;
}

export const smtpReady = (s) => !!(s?.smtp_enabled && s.smtp_host && s.smtp_user && s.smtp_pass);
export const smsReady = (s) => {
  if (!s?.sms_enabled) return false;
  if (s.sms_provider === 'custom') return !!s.sms_base_url;
  if (s.sms_provider === 'infobip') return !!(s.sms_secret && s.sms_base_url && s.sms_sender);
  return !!(s.sms_account_id && s.sms_secret && s.sms_sender);
};

export async function sendSmtp(s, { to, subject, html, text }) {
  const transport = nodemailer.createTransport({
    host: s.smtp_host,
    port: Number(s.smtp_port) || 465,
    secure: !!s.smtp_secure,
    auth: { user: s.smtp_user, pass: s.smtp_pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  const fromEmail = s.smtp_from_email || s.smtp_user;
  const from = s.smtp_from_name ? `"${String(s.smtp_from_name).replace(/"/g, '')}" <${fromEmail}>` : fromEmail;
  const info = await transport.sendMail({ from, to, subject, html, text });
  return { provider: 'smtp', id: info.messageId };
}

async function check(res, label) {
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  try { return JSON.parse(body); } catch { return body; }
}

/** Send one SMS through the configured provider. `to` must be E.164 (+216…). */
export async function sendSms(s, to, message) {
  const p = s.sms_provider;
  if (p === 'twilio') {
    const params = new URLSearchParams({ To: to, Body: message });
    // A Messaging Service SID (MG…) or a sender number / alphanumeric ID.
    if (/^MG[0-9a-f]{32}$/i.test(s.sms_sender)) params.set('MessagingServiceSid', s.sms_sender);
    else params.set('From', s.sms_sender);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.sms_account_id)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.sms_account_id}:${s.sms_secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const j = await check(res, 'twilio');
    return { provider: 'twilio', id: j?.sid };
  }
  if (p === 'vonage') {
    const res = await fetch('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: s.sms_account_id, api_secret: s.sms_secret, from: s.sms_sender, to: to.replace(/^\+/, ''), text: message }),
    });
    const j = await check(res, 'vonage');
    const m = j?.messages?.[0];
    if (m && m.status !== '0') throw new Error(`vonage: ${m['error-text'] || m.status}`);
    return { provider: 'vonage', id: m?.['message-id'] };
  }
  if (p === 'infobip') {
    const base = String(s.sms_base_url).replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://');
    const res = await fetch(`${base}/sms/2/text/advanced`, {
      method: 'POST',
      headers: { Authorization: `App ${s.sms_secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messages: [{ from: s.sms_sender, destinations: [{ to: to.replace(/^\+/, '') }], text: message }] }),
    });
    const j = await check(res, 'infobip');
    return { provider: 'infobip', id: j?.messages?.[0]?.messageId };
  }
  if (p === 'custom') {
    if (!/^https:\/\//i.test(s.sms_base_url)) throw new Error('custom SMS URL must use https://');
    const headers = { 'Content-Type': 'application/json' };
    if (s.sms_secret) headers.Authorization = `Bearer ${s.sms_secret}`;
    const res = await fetch(s.sms_base_url, {
      method: 'POST', headers, body: JSON.stringify({ to, from: s.sms_sender || undefined, message }),
    });
    await check(res, 'custom sms');
    return { provider: 'custom' };
  }
  throw new Error(`Unknown SMS provider "${p}"`);
}

export async function trySendSms(to, message) {
  const s = await getMessagingSettings();
  if (!smsReady(s)) return null;
  try { return await sendSms(s, to, message); } catch (e) { log.error('sms failed', { err: e.message }); throw e; }
}
