// Outgoing transactional email (password reset, sign-up confirmation).
//
// Two providers, both plain HTTPS so there is no extra dependency:
//   • RESEND_API_KEY      → https://api.resend.com/emails
//   • EMAIL_WEBHOOK_URL   → your own sender; receives { to, subject, html, text }
//                           and, when EMAIL_WEBHOOK_SECRET is set, the header
//                           `x-webhook-secret`.
//
// With neither configured the message is logged instead of sent — allowed in
// development only; in production sendMail() throws so the caller returns 500
// rather than silently swallowing a password-reset request.
import { config, emailConfigured } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('mail');

async function sendViaResend({ to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: config.email.from, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`resend HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return { provider: 'resend' };
}

async function sendViaWebhook({ to, subject, html, text }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.email.webhookSecret) headers['x-webhook-secret'] = config.email.webhookSecret;
  const res = await fetch(config.email.webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: config.email.from, to, subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email webhook HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return { provider: 'webhook' };
}

/** @returns {Promise<{ provider: 'resend'|'webhook'|'log' }>} */
export async function sendMail({ to, subject, html, text }) {
  if (!to) throw new Error('sendMail: "to" is required');
  const plain = text || String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (config.email.resendApiKey) return sendViaResend({ to, subject, html, text: plain });
  if (config.email.webhookUrl) return sendViaWebhook({ to, subject, html, text: plain });

  if (config.isProduction) throw new Error('No email provider configured (set RESEND_API_KEY or EMAIL_WEBHOOK_URL)');
  log.warn('no email provider configured — logging message instead', { to, subject, text: plain });
  return { provider: 'log' };
}

export const canSendMail = emailConfigured;

const shell = (title, body, buttonLabel, link) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${title}</h2>
    <p style="margin:0 0 20px;line-height:1.5">${body}</p>
    <p style="margin:0 0 24px">
      <a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#111;color:#fff;text-decoration:none">${buttonLabel}</a>
    </p>
    <p style="margin:0;font-size:12px;color:#666;word-break:break-all">${link}</p>
  </div>`;

export const recoveryEmail = (link) => ({
  subject: 'Reset your password',
  html: shell('Reset your password', 'Click the button below to choose a new password. The link expires in one hour.', 'Reset password', link),
});

export const confirmationEmail = (link) => ({
  subject: 'Confirm your email address',
  html: shell('Confirm your email', 'Click the button below to confirm your email address and activate your account.', 'Confirm email', link),
});
