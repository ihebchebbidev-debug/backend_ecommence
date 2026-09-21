// Port of supabase/functions/reset-otp-rate-limit/index.ts
import { json, clientIp, methodGuard } from './_shared/respond.js';

function normalizePhone(raw) {
  const clean = String(raw).replace(/[\s\-().]/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('00')) return '+' + clean.slice(2);
  if (clean.startsWith('216') && clean.length === 11) return '+' + clean;
  if (/^\d{8}$/.test(clean)) return '+216' + clean;
  return '+' + clean.replace(/\D/g, '');
}
const isTunisianPhone = (phone) => /^\+216\d{8}$/.test(phone);

export default async function resetOtpRateLimit(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Action non autorisée.' }, 401);

  const roleRow = await ctx.q('SELECT role FROM public.admin_roles WHERE user_id = $1', [ctx.userId]).then((r) => r[0]);
  if (roleRow?.role !== 'super_admin') return json(res, { error: 'Action non autorisée.' }, 403);

  const body = req.body || {};
  const rawPhone = String(body.phone ?? '').trim();
  if (!rawPhone) return json(res, { error: 'Numéro de téléphone requis' }, 400);

  const phone = normalizePhone(rawPhone);
  if (!isTunisianPhone(phone)) {
    return json(res, { error: 'Seuls les numéros tunisiens +216 sont autorisés.', code: 'NON_TUNISIAN' }, 400);
  }

  const ip = clientIp(req);
  const windowStart = new Date(Date.now() - 2 * 3_600_000).toISOString();

  const phoneDeletedRows = await ctx.q(
    `DELETE FROM public.otp_verification_logs WHERE phone=$1 AND status IN ('sent','failed','blocked') AND created_at >= $2 RETURNING id`,
    [phone, windowStart],
  );
  const phoneDeleted = phoneDeletedRows.length;

  let ipDeleted = 0;
  if (ip !== 'unknown') {
    const ipDeletedRows = await ctx.q(
      `DELETE FROM public.otp_verification_logs WHERE ip_address=$1 AND status IN ('sent','failed','blocked') AND created_at >= $2 RETURNING id`,
      [ip, windowStart],
    );
    ipDeleted = ipDeletedRows.length;
  }

  await ctx.q(`UPDATE public.phone_otp_codes SET used=true WHERE phone=$1 AND used=false`, [phone]);

  const codesClearedRows = await ctx.q(
    `UPDATE public.phone_otp_codes SET used=true WHERE user_id=$1 AND used=false RETURNING id`,
    [ctx.userId],
  );
  const codesCleared = codesClearedRows.length;

  const profile = await ctx.q('SELECT email FROM public.profiles WHERE id = $1', [ctx.userId]).then((r) => r[0]);

  await ctx.q(
    `INSERT INTO public.otp_rate_limit_resets (actor_id, actor_email, target_phone, rows_deleted) VALUES ($1,$2,$3,$4)`,
    [ctx.userId, profile?.email ?? 'unknown', phone, phoneDeleted + ipDeleted],
  );

  return json(res, {
    success: true,
    message: 'Limites OTP réinitialisées pour ce numéro.',
    phone,
    phone_logs_deleted: phoneDeleted,
    ip_logs_deleted: ipDeleted,
    codes_cleared: codesCleared,
  });
}
