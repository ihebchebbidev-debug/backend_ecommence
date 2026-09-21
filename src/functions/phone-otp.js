// Port of supabase/functions/phone-otp/index.ts
import { json, clientIp, methodGuard } from './_shared/respond.js';
import { config } from '../config.js';

const MAX_PHONE_SENDS_1H = 3;
const MAX_IP_SENDS_1H = 5;
const OTP_COOLDOWN_SECS = 60;
const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

function normalizePhone(raw) {
  const clean = String(raw).replace(/[\s\-().]/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('00')) return '+' + clean.slice(2);
  if (clean.startsWith('216') && clean.length === 11) return '+' + clean;
  if (/^\d{8}$/.test(clean)) return '+216' + clean;
  return '+' + clean.replace(/\D/g, '');
}

const isTunisianPhone = (phone) => /^\+216\d{8}$/.test(phone);

function logAttempt(ctx, opts) {
  ctx
    .q(
      `INSERT INTO public.otp_verification_logs (user_id, phone, provider, method, ip_address, status, error_msg, error_code, twilio_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        opts.userId, opts.phone, opts.provider, opts.method, opts.ip, opts.status,
        opts.errorMsg ?? null, opts.errorCode ?? null, opts.twilioStatus ?? null,
      ],
    )
    .catch((e) => console.error('[phone-otp] log error:', e.message));
}

export default async function phoneOtp(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Unauthorized' }, 401);
  const userId = ctx.userId;
  const profile = await ctx.q('SELECT email FROM public.profiles WHERE id = $1', [userId]).then((r) => r[0]);

  const pvs = await ctx.q(
    'SELECT provider, account_sid, auth_token, verify_service_sid, enabled FROM public.phone_verification_settings WHERE id = $1',
    [SETTINGS_ID],
  ).then((r) => r[0] || null);

  const twilioSid = pvs?.account_sid;
  const twilioToken = pvs?.auth_token;
  const twilioVSid = pvs?.verify_service_sid;
  const isTwilio = pvs?.provider === 'twilio' && twilioSid?.trim() && twilioToken?.trim() && twilioVSid?.trim();
  const provider = isTwilio ? 'twilio' : 'dev';

  const body = req.body || {};
  const action = String(body.action ?? '');

  if (action === 'send') {
    const rawPhone = String(body.phone ?? '');
    const channel = body.channel === 'sms' ? 'sms' : 'whatsapp';
    if (!rawPhone) return json(res, { error: 'Téléphone requis' }, 400);

    const phone = normalizePhone(rawPhone);
    const ip = clientIp(req);

    if (!isTunisianPhone(phone)) {
      logAttempt(ctx, { userId, phone, method: channel, provider, ip, status: 'blocked', errorMsg: 'non_tunisian_number' });
      return json(res, { error: 'Seuls les numéros tunisiens +216 sont autorisés.', code: 'NON_TUNISIAN' }, 400);
    }

    const logBase = { userId, phone, method: channel, provider, ip };
    const now1H = new Date(Date.now() - 3_600_000).toISOString();

    const callerRole = await ctx.q('SELECT role FROM public.admin_roles WHERE user_id = $1', [userId]).then((r) => r[0]);
    const isSuperAdminCaller = callerRole?.role === 'super_admin' || callerRole?.role === 'limited_super_admin';

    const phoneCountRow = await ctx.q(
      `SELECT COUNT(*)::int AS c FROM public.otp_verification_logs WHERE phone=$1 AND status IN ('sent','failed') AND created_at >= $2`,
      [phone, now1H],
    ).then((r) => r[0]);
    const phoneCount = phoneCountRow?.c ?? 0;
    if (phoneCount >= MAX_PHONE_SENDS_1H) {
      logAttempt(ctx, { ...logBase, status: 'blocked', errorMsg: 'rate_limit_phone_1h' });
      return json(res, {
        error: 'Trop de tentatives sur ce numéro. Attendez 1 heure ou utilisez Reset OTP limits.',
        rate_limited: true, limit_source: 'phone_hourly', limit_count: phoneCount,
      }, 429);
    }

    const recentSend = await ctx.q(
      `SELECT created_at FROM public.otp_verification_logs WHERE phone=$1 AND status='sent' AND created_at >= $2 ORDER BY created_at DESC LIMIT 1`,
      [phone, new Date(Date.now() - OTP_COOLDOWN_SECS * 1000).toISOString()],
    ).then((r) => r[0]);
    if (recentSend) {
      const waitSecs = Math.ceil(OTP_COOLDOWN_SECS - (Date.now() - new Date(recentSend.created_at).getTime()) / 1000);
      logAttempt(ctx, { ...logBase, status: 'blocked', errorMsg: `cooldown:${waitSecs}s` });
      return json(res, { error: 'wait', wait_seconds: waitSecs, limit_source: 'phone_cooldown' }, 429);
    }

    const ipCountRow = await ctx.q(
      `SELECT COUNT(*)::int AS c FROM public.otp_verification_logs WHERE ip_address=$1 AND status IN ('sent','failed') AND created_at >= $2`,
      [ip, now1H],
    ).then((r) => r[0]);
    const ipCount = ipCountRow?.c ?? 0;
    if (ipCount >= MAX_IP_SENDS_1H) {
      logAttempt(ctx, { ...logBase, status: 'blocked', errorMsg: 'rate_limit_ip_hourly' });
      return json(res, {
        error: 'Trop de tentatives depuis cette adresse IP. Attendez 1 heure ou utilisez Reset OTP limits.',
        rate_limited: true, limit_source: 'ip_hourly', limit_count: ipCount,
      }, 429);
    }

    const lastCode = await ctx.q(
      `SELECT created_at, resend_count FROM public.phone_otp_codes WHERE user_id=$1 AND used=false ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ).then((r) => r[0]);

    if (lastCode) {
      const secondsSince = (Date.now() - new Date(lastCode.created_at).getTime()) / 1000;
      if (secondsSince < OTP_COOLDOWN_SECS) {
        const waitSecs = Math.ceil(OTP_COOLDOWN_SECS - secondsSince);
        logAttempt(ctx, { ...logBase, status: 'blocked', errorMsg: `user_cooldown:${waitSecs}s` });
        return json(res, { error: 'wait', wait_seconds: waitSecs, limit_source: 'user_cooldown' }, 429);
      }
      if ((lastCode.resend_count ?? 0) >= MAX_PHONE_SENDS_1H && !isSuperAdminCaller) {
        logAttempt(ctx, { ...logBase, status: 'blocked', errorMsg: 'user_max_resends' });
        return json(res, {
          error: 'Trop de tentatives. Attendez 1 heure ou utilisez Reset OTP limits.',
          rate_limited: true, limit_source: 'user_resend_count',
        }, 429);
      }
    }

    await ctx.q(`UPDATE public.phone_otp_codes SET used=true WHERE user_id=$1 AND used=false`, [userId]);

    const newResendCount = (lastCode?.resend_count ?? 0) + 1;

    if (isTwilio) {
      const twilioChannel = channel === 'whatsapp' ? 'whatsapp' : 'sms';
      let verifyRes;
      try {
        verifyRes = await fetch(`https://verify.twilio.com/v2/Services/${twilioVSid}/Verifications`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: phone, Channel: twilioChannel }),
        });
      } catch (fetchErr) {
        logAttempt(ctx, { ...logBase, status: 'failed', errorMsg: `network: ${fetchErr.message}` });
        return json(res, { error: 'Impossible de joindre Twilio. Vérifiez la connexion.', source: 'network_error', safe_error_msg: fetchErr.message }, 502);
      }

      if (!verifyRes.ok) {
        let errJson = {};
        try { errJson = await verifyRes.json(); } catch { /* ignore */ }
        const twilioCode = String(errJson.code ?? '');
        const twilioMsg = String(errJson.message ?? errJson.detail ?? `Erreur Twilio HTTP ${verifyRes.status}`);
        logAttempt(ctx, { ...logBase, status: 'failed', errorMsg: twilioMsg, errorCode: twilioCode || null });
        let userMsg = twilioMsg;
        if (twilioCode === '60200') userMsg = 'Numéro de téléphone invalide selon Twilio.';
        if (twilioCode === '60203') userMsg = 'Trop de tentatives pour ce numéro (limite Twilio). Attendez.';
        if (twilioCode === '60205') userMsg = "Le canal WhatsApp n'est pas disponible sur ce numéro.";
        if (twilioCode === '20003') userMsg = 'Credentials Twilio invalides. Vérifiez Account SID / Auth Token.';
        if (twilioCode === '20404') userMsg = 'Verify Service SID introuvable. Vérifiez votre configuration.';
        return json(res, { error: userMsg, twilio_code: twilioCode || null, twilio_raw_msg: twilioMsg, provider: 'twilio' }, 400);
      }

      let twilioStatus = 'pending';
      try { const ok = await verifyRes.json(); twilioStatus = String(ok.status ?? 'pending'); } catch { /* ignore */ }

      await ctx.q(
        `INSERT INTO public.phone_otp_codes (user_id, phone, code, channel, resend_count, expires_at) VALUES ($1,$2,'__TWILIO__',$3,$4,$5)`,
        [userId, phone, channel, newResendCount, new Date(Date.now() + 10 * 60 * 1000).toISOString()],
      );
      logAttempt(ctx, { ...logBase, status: 'sent', twilioStatus, provider: 'twilio' });
      return json(res, { sent: true, channel, expires_in: 600, provider: 'twilio' });
    }

    const missingFields = [];
    if (!pvs?.account_sid) missingFields.push('Account SID');
    if (!pvs?.auth_token) missingFields.push('Auth Token');
    if (!pvs?.verify_service_sid) missingFields.push('Verify Service SID');
    if (pvs?.provider !== 'twilio') missingFields.push(`provider=${pvs?.provider ?? 'non configuré'}`);

    // config.devOtpAllowed is forced to false when NODE_ENV=production, so a
    // stray DEV_OTP_ALLOWED=true can never leak codes on a live deployment.
    const allowDevCode = config.devOtpAllowed && isSuperAdminCaller;

    if (!allowDevCode) {
      logAttempt(ctx, { ...logBase, status: 'failed', errorMsg: 'otp_provider_not_configured' });
      return json(res, { error: "OTP provider not configured. Contactez l'administrateur.", code: 'OTP_PROVIDER_NOT_CONFIGURED', provider: 'dev' }, 503);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await ctx.q(
      `INSERT INTO public.phone_otp_codes (user_id, phone, code, channel, resend_count, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, phone, otp, channel, newResendCount, new Date(Date.now() + 5 * 60 * 1000).toISOString()],
    );
    logAttempt(ctx, { ...logBase, status: 'sent', twilioStatus: 'dev', provider: 'dev' });
    return json(res, { sent: true, channel, expires_in: 300, dev_code: otp, dev_mode: true, provider: 'dev', missing_config: missingFields });
  }

  if (action === 'verify') {
    const code = String(body.code ?? '').trim();
    if (!code || code.length !== 6) return json(res, { error: 'Code invalide' }, 400);

    const phoneHint = body.phone ? normalizePhone(String(body.phone)) : null;

    const record = await ctx.q(
      `SELECT id, phone, code, channel FROM public.phone_otp_codes WHERE user_id=$1 AND used=false AND expires_at >= now() ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ).then((r) => r[0]);

    if (!record) return json(res, { error: 'Code incorrect ou expiré — aucun OTP actif. Renvoyez un nouveau code.' }, 400);

    const targetPhone = phoneHint ?? record.phone;
    const ip = clientIp(req);

    if (record.code === '__TWILIO__') {
      const pvsVerify = await ctx.q(
        'SELECT provider, account_sid, auth_token, verify_service_sid FROM public.phone_verification_settings WHERE id = $1',
        [SETTINGS_ID],
      ).then((r) => r[0]);

      const vSid = pvsVerify?.verify_service_sid;
      const vSID = pvsVerify?.account_sid;
      const vToken = pvsVerify?.auth_token;

      if (!vSid || !vSID || !vToken) {
        return json(res, { error: 'Configuration Twilio manquante. Contactez l\'administrateur.' }, 500);
      }

      let checkRes;
      try {
        checkRes = await fetch(`https://verify.twilio.com/v2/Services/${vSid}/VerificationChecks`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${vSID}:${vToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: targetPhone, Code: code }),
        });
      } catch {
        return json(res, { error: 'Erreur réseau vers Twilio lors de la vérification.' }, 502);
      }

      let checkJson = {};
      try { checkJson = await checkRes.json(); } catch { /* ignore */ }

      if (!checkRes.ok || checkJson.status !== 'approved') {
        return json(res, { error: 'Code incorrect ou expiré.', twilio_status: checkJson.status }, 400);
      }

      await ctx.q(`UPDATE public.phone_otp_codes SET used=true WHERE id=$1`, [record.id]);
      await ctx.q(
        `INSERT INTO public.profiles (id, phone, phone_verified, phone_verified_at, otp_channel)
         VALUES ($1,$2,true,now(),$3)
         ON CONFLICT (id) DO UPDATE SET phone=EXCLUDED.phone, phone_verified=true, phone_verified_at=now(), otp_channel=EXCLUDED.otp_channel`,
        [userId, targetPhone, record.channel],
      ).catch((e) => { throw e; });

      logAttempt(ctx, { userId, phone: targetPhone, method: record.channel, provider: 'twilio', ip, status: 'verified' });
      return json(res, { verified: true });
    }

    if (record.code !== code) return json(res, { error: 'Code incorrect ou expiré.' }, 400);

    await ctx.q(`UPDATE public.phone_otp_codes SET used=true WHERE id=$1`, [record.id]);
    await ctx.q(
      `INSERT INTO public.profiles (id, phone, phone_verified, phone_verified_at, otp_channel)
       VALUES ($1,$2,true,now(),$3)
       ON CONFLICT (id) DO UPDATE SET phone=EXCLUDED.phone, phone_verified=true, phone_verified_at=now(), otp_channel=EXCLUDED.otp_channel`,
      [userId, record.phone, record.channel],
    );

    logAttempt(ctx, { userId, phone: record.phone, method: record.channel, provider: 'dev', ip, status: 'verified' });
    return json(res, { verified: true });
  }

  return json(res, { error: `Action inconnue: ${action}` }, 400);
}
