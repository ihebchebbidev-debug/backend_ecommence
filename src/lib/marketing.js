// Loyalty points award + seller email campaign delivery, run by the shared automation worker.
import crypto from 'node:crypto';
import net from 'node:net';
import { config } from '../config.js';
import { sendSmtp } from './messaging.js';
import { renderEmail, renderText } from './emailBlocks.js';

export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const SMTP_PORTS = [25, 465, 587, 2525];
export const MAX_EMAIL_ATTEMPTS = 3;

/** Same digits for "22 123 456", "+216 22123456" and "0021622123456". */
export function phoneKey(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = `216${d}`;
  return /^\d{8,15}$/.test(d) ? d : null;
}
export const SQL_PHONE_KEY = `(CASE WHEN length(regexp_replace(coalesce(o.client_phone,''),'\\D','','g')) = 8 THEN '216' ELSE '' END
  || regexp_replace(regexp_replace(coalesce(o.client_phone,''),'\\D','','g'),'^00',''))`;

/** Bronze / Silver / Gold from lifetime points. */
export function tierFor(lifetime, s) {
  if (lifetime >= Number(s?.gold_points ?? 1500)) return 'gold';
  if (lifetime >= Number(s?.silver_points ?? 500)) return 'silver';
  return 'bronze';
}
export const pointsFor = (amount, perUnit) => Math.max(0, Math.floor(Number(amount || 0) * Number(perUnit || 0)));

/** Awards points once per delivered order (only orders placed after the programme was enabled). */
export async function awardLoyaltyPoints(q) {
  await q(`WITH due AS (
      SELECT o.id, o.store_id, max(o.client_name) AS client_name, ${SQL_PHONE_KEY} AS phone,
             floor(o.amount * s.points_per_unit)::int AS pts
      FROM public.orders o JOIN public.store_loyalty_settings s ON s.store_id = o.store_id AND s.enabled
      WHERE (o.status = 'delivered' OR o.delivery_status = 'delivered') AND o.deleted_at IS NULL
        AND s.enabled_at IS NOT NULL AND o.created_at >= s.enabled_at
        AND NOT EXISTS (SELECT 1 FROM public.store_loyalty_ledger l WHERE l.order_id = o.id)
      GROUP BY o.id, o.store_id, s.points_per_unit LIMIT 500),
    ins AS (INSERT INTO public.store_loyalty_ledger(store_id, phone, order_id, points, reason)
      SELECT store_id, phone, id, pts, 'order_delivered' FROM due WHERE pts > 0 AND length(phone) BETWEEN 8 AND 15
      ON CONFLICT DO NOTHING RETURNING store_id, phone, order_id, points)
    INSERT INTO public.store_loyalty_accounts AS a(store_id, phone, name, points, lifetime_points)
    SELECT i.store_id, i.phone, coalesce(max(d.client_name), ''), sum(i.points)::int, sum(i.points)::int
    FROM ins i JOIN due d ON d.id = i.order_id GROUP BY i.store_id, i.phone
    ON CONFLICT (store_id, phone) DO UPDATE SET points = a.points + EXCLUDED.points,
      lifetime_points = a.lifetime_points + EXCLUDED.lifetime_points,
      name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE a.name END, updated_at = now()`);
}

/** Refuses internal addresses so a seller cannot make the server connect to private hosts. */
export function validSmtpHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h.length > 253 || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return false;
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h);
}
export const smtpOf = (s) => ({ smtp_host: s.smtp_host, smtp_port: s.smtp_port, smtp_secure: s.smtp_secure, smtp_user: s.smtp_user,
  smtp_pass: s.smtp_pass, smtp_from_email: s.from_email || s.smtp_user, smtp_from_name: s.from_name });
export const sellerSmtpReady = (s) => !!(s && validSmtpHost(s.smtp_host) && SMTP_PORTS.includes(Number(s.smtp_port)) && s.smtp_user && s.smtp_pass);

export const unsubscribeToken = (recipientId) => crypto.createHmac('sha256', config.jwtSecret || 'unset').update(`unsub:${recipientId}`).digest('base64url');
export function checkUnsubscribeToken(recipientId, token) {
  const want = Buffer.from(unsubscribeToken(recipientId));
  const got = Buffer.from(String(token || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
export const unsubscribeUrl = (recipientId) => `${config.publicUrl}/email-unsubscribe?r=${recipientId}&t=${unsubscribeToken(recipientId)}`;

/** Sends a batch of pending campaign emails through each shop's own SMTP. */
export async function processCampaigns(q, log, batch = 40) {
  const rows = await q(`SELECT r.id, r.email, r.name, r.attempts, r.campaign_id, c.subject, c.preheader, c.accent, c.blocks, s.store_name,
      es.smtp_host, es.smtp_port, es.smtp_secure, es.smtp_user, es.smtp_pass, es.from_email, es.from_name,
      EXISTS (SELECT 1 FROM public.store_email_unsubscribes u WHERE u.store_id = r.store_id AND u.email = r.email) AS unsubscribed
    FROM public.store_email_recipients r
    JOIN public.store_email_campaigns c ON c.id = r.campaign_id AND c.status = 'sending'
    JOIN public.platform_stores s ON s.id = r.store_id
    LEFT JOIN public.store_email_settings es ON es.store_id = r.store_id
    WHERE r.sent_at IS NULL AND r.attempts < $1 ORDER BY r.attempts, r.id LIMIT $2`, [MAX_EMAIL_ATTEMPTS, batch]);
  const touched = new Set();
  for (const r of rows) {
    touched.add(r.campaign_id);
    if (r.unsubscribed || !sellerSmtpReady(r)) {
      await q('UPDATE public.store_email_recipients SET attempts=$2, error=$3 WHERE id=$1', [r.id, MAX_EMAIL_ATTEMPTS, r.unsubscribed ? 'unsubscribed' : 'smtp_not_configured']);
      continue;
    }
    const link = unsubscribeUrl(r.id);
    const args = { blocks: r.blocks, preheader: r.preheader, accent: r.accent, shopName: r.store_name, name: r.name, unsubscribeUrl: link };
    try {
      await sendSmtp(smtpOf(r), { to: r.email, subject: r.subject, html: renderEmail(args), text: renderText(args) });
      await q('UPDATE public.store_email_recipients SET sent_at=now(), attempts=attempts+1, error=NULL WHERE id=$1', [r.id]);
    } catch (e) {
      await q('UPDATE public.store_email_recipients SET attempts=attempts+1, error=$2 WHERE id=$1', [r.id, String(e?.message || e).slice(0, 300)]);
    }
  }
  for (const id of touched) {
    await q(`UPDATE public.store_email_campaigns c SET
        sent_count = (SELECT count(*) FROM public.store_email_recipients WHERE campaign_id = c.id AND sent_at IS NOT NULL),
        failed_count = (SELECT count(*) FROM public.store_email_recipients WHERE campaign_id = c.id AND sent_at IS NULL AND attempts >= $2),
        last_error = (SELECT error FROM public.store_email_recipients WHERE campaign_id = c.id AND error IS NOT NULL ORDER BY attempts DESC LIMIT 1),
        status = CASE WHEN EXISTS (SELECT 1 FROM public.store_email_recipients WHERE campaign_id = c.id AND sent_at IS NULL AND attempts < $2) THEN 'sending' ELSE 'sent' END,
        sent_at = coalesce(c.sent_at, now()), updated_at = now()
      WHERE c.id = $1`, [id, MAX_EMAIL_ATTEMPTS]);
  }
  if (rows.length) log?.debug?.('email campaigns', { processed: rows.length });
}
