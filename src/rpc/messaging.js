// Super-admin RPCs for platform SMTP / SMS settings and verification-code toggles.
import { forbidden, badRequest } from '../lib/errors.js';
import {
  SMTP_PRESETS, SMS_PROVIDERS, SECRET_FIELDS, getMessagingSettings, invalidateMessagingSettings,
  smtpReady, smsReady, sendSmtp, sendSms,
} from '../lib/messaging.js';
import { normalizePhone } from '../auth/otp.js';

async function requireSuperAdmin(ctx) {
  ctx.requireAuth();
  if (!(await ctx.isSuperAdmin())) throw forbidden('Super admin access required');
}

const TEXT = ['smtp_preset', 'smtp_host', 'smtp_user', 'smtp_from_email', 'smtp_from_name', 'sms_provider', 'sms_account_id', 'sms_sender', 'sms_base_url'];
const BOOL = ['smtp_enabled', 'smtp_secure', 'sms_enabled', 'otp_signup_email', 'otp_signup_sms', 'otp_signin_email', 'otp_signin_sms', 'otp_reset_email', 'otp_reset_sms'];

function publicView(s) {
  const out = { ...s };
  for (const f of SECRET_FIELDS) { out[`${f}_set`] = !!s[f]; delete out[f]; }
  out.smtp_ready = smtpReady(s);
  out.sms_ready = smsReady(s);
  return out;
}

export default {
  async admin_get_messaging_settings(_args, ctx) {
    await requireSuperAdmin(ctx);
    invalidateMessagingSettings();
    return publicView(await getMessagingSettings());
  },

  async admin_save_messaging_settings({ p_settings = {} }, ctx) {
    await requireSuperAdmin(ctx);
    const sets = [];
    const params = [];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    for (const k of TEXT) if (typeof p_settings[k] === 'string') put(k, p_settings[k].trim().slice(0, 500));
    for (const k of BOOL) if (typeof p_settings[k] === 'boolean') put(k, p_settings[k]);
    if (p_settings.smtp_port !== undefined) {
      const port = Number(p_settings.smtp_port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Port SMTP invalide');
      put('smtp_port', port);
    }
    // Blank secret = keep the saved one.
    for (const k of SECRET_FIELDS) if (typeof p_settings[k] === 'string' && p_settings[k] !== '') put(k, p_settings[k]);
    if (p_settings.smtp_preset && !(p_settings.smtp_preset in SMTP_PRESETS)) throw badRequest('Fournisseur email inconnu');
    if (p_settings.sms_provider && !SMS_PROVIDERS.includes(p_settings.sms_provider)) throw badRequest('Fournisseur SMS inconnu');
    if (p_settings.sms_provider === 'custom' && p_settings.sms_base_url && !/^https:\/\//i.test(p_settings.sms_base_url))
      throw badRequest("L'adresse du fournisseur SMS doit commencer par https://");
    put('updated_by', ctx.userId);
    await ctx.q('INSERT INTO public.platform_messaging_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await ctx.q(`UPDATE public.platform_messaging_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, params);
    invalidateMessagingSettings();
    return publicView(await getMessagingSettings());
  },

  async admin_test_messaging({ p_channel, p_to }, ctx) {
    await requireSuperAdmin(ctx);
    invalidateMessagingSettings();
    const s = await getMessagingSettings();
    try {
      if (p_channel === 'email') {
        if (!s.smtp_host || !s.smtp_user || !s.smtp_pass) return { ok: false, error: 'Renseignez serveur, utilisateur et mot de passe SMTP.' };
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p_to || ''))) return { ok: false, error: 'Adresse email invalide' };
        const r = await sendSmtp(s, { to: p_to, subject: 'Test email — configuration SMTP', html: '<p>Votre configuration SMTP fonctionne ✅</p>', text: 'Votre configuration SMTP fonctionne.' });
        return { ok: true, ...r };
      }
      if (p_channel === 'sms') {
        const to = normalizePhone(p_to);
        if (!to) return { ok: false, error: 'Numéro invalide (format +216XXXXXXXX)' };
        const r = await sendSms({ ...s, sms_enabled: true }, to, 'Test SMS : votre configuration fonctionne.');
        return { ok: true, ...r };
      }
      return { ok: false, error: 'Canal inconnu' };
    } catch (e) {
      return { ok: false, error: String(e.message || e).slice(0, 400) };
    }
  },
};
