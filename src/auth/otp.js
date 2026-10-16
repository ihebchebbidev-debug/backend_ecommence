// Account verification codes (sign-up, sign-in, password reset) over email/SMS.
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { sendMail, otpEmail } from '../lib/mailer.js';
import { getMessagingSettings, smtpReady, smsReady, sendSms } from '../lib/messaging.js';

const log = createLogger('otp');
const TTL_MIN = 10;
const COOLDOWN_SECS = 60;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
export const PURPOSES = ['signup', 'signin', 'reset'];

export function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s().-]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (/^\d{8}$/.test(p)) p = `+216${p}`;
  if (/^216\d{8}$/.test(p)) p = `+${p}`;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

const devMode = () => config.devOtpAllowed && !config.isProduction;
const channelReady = (s, ch) => (ch === 'email' ? smtpReady(s) || !!(config.email.resendApiKey || config.email.webhookUrl) : smsReady(s));

/** Which code checks are actually enforced (a toggle only counts when its channel can deliver). */
export async function otpRequirements() {
  const s = await getMessagingSettings();
  const out = {};
  for (const p of PURPOSES) {
    out[p] = {
      email: !!s[`otp_${p}_email`] && (channelReady(s, 'email') || devMode()),
      sms: !!s[`otp_${p}_sms`] && (channelReady(s, 'sms') || devMode()),
    };
  }
  return out;
}

const hash = (code, target) => crypto.createHash('sha256').update(`${code}:${target}`).digest('hex');
export const mask = (ch, t) => (ch === 'email'
  ? t.replace(/^(.).*(@.*)$/, (_, a, b) => `${a}***${b}`)
  : t.replace(/^(\+\d{3})\d*(\d{2})$/, '$1 *** ** $2'));

export async function issueOtp({ purpose, channel, target, ip }) {
  const recent = await one(
    `SELECT count(*)::int AS n, max(created_at) AS last FROM public.auth_otp_codes
      WHERE purpose = $1 AND channel = $2 AND target = $3 AND created_at > now() - interval '1 hour'`,
    [purpose, channel, target],
  );
  if (recent?.last && Date.now() - new Date(recent.last).getTime() < COOLDOWN_SECS * 1000)
    throw new ApiError(429, 'Veuillez patienter avant de renvoyer un code', { code: 'otp_cooldown' });
  if ((recent?.n || 0) >= MAX_PER_HOUR)
    throw new ApiError(429, 'Trop de codes envoyés, réessayez plus tard', { code: 'over_request_rate_limit' });

  const code = String(crypto.randomInt(100000, 1000000));
  await q(
    `INSERT INTO public.auth_otp_codes (purpose, channel, target, code_hash, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '${TTL_MIN} minutes')`,
    [purpose, channel, target, hash(code, target), ip || null],
  );

  const s = await getMessagingSettings();
  if (!channelReady(s, channel)) {
    if (devMode()) { log.warn('dev OTP (no provider)', { purpose, channel, target, code }); return { dev_code: code }; }
    throw new ApiError(503, channel === 'sms' ? "L'envoi de SMS n'est pas configuré" : "L'envoi d'email n'est pas configuré", { code: 'otp_provider_unavailable' });
  }
  try {
    if (channel === 'email') await sendMail({ to: target, ...otpEmail(code, purpose) });
    else await sendSms(s, target, `Votre code de vérification : ${code} (valable ${TTL_MIN} min)`);
  } catch (e) {
    log.error('otp delivery failed', { channel, err: e.message });
    throw new ApiError(502, "Impossible d'envoyer le code, réessayez", { code: 'otp_send_failed' });
  }
  return {};
}

/** Consume a valid code; throws on mismatch/expiry. */
export async function verifyOtp({ purpose, channel, target, code }) {
  const row = await one(
    `SELECT * FROM public.auth_otp_codes
      WHERE purpose = $1 AND channel = $2 AND target = $3 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [purpose, channel, target],
  );
  const bad = () => new ApiError(400, 'Code invalide ou expiré', { code: 'otp_invalid' });
  if (!row || row.attempts >= MAX_ATTEMPTS) throw bad();
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hash(String(code || '').trim(), target)));
  if (!ok) {
    await q('UPDATE public.auth_otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw bad();
  }
  await q('UPDATE public.auth_otp_codes SET consumed_at = now() WHERE id = $1', [row.id]);
}

/** Phone on file for a user (auth record first, then profile). */
export async function userPhone(user) {
  const fromAuth = normalizePhone(user.phone);
  if (fromAuth) return fromAuth;
  const p = await one('SELECT phone FROM public.profiles WHERE id = $1', [user.id]).catch(() => null);
  return normalizePhone(p?.phone || user.raw_user_meta_data?.phone);
}

/** Channel + destination for sign-in / reset: SMS when required and a phone exists, else email. */
export async function pickChannel(purpose, user) {
  const req = (await otpRequirements())[purpose];
  if (req.sms) {
    const phone = await userPhone(user);
    if (phone) return { channel: 'sms', target: phone };
  }
  if (req.email || req.sms) return { channel: 'email', target: user.email };
  return null;
}

export function assertPurpose(p) {
  if (!PURPOSES.includes(p)) throw badRequest('invalid purpose');
}
