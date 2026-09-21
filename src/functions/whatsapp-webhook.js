// Port of supabase/functions/whatsapp-webhook/index.ts
// Note: express.raw() is mounted for this route in server.js, so req.body is a Buffer.
import crypto from 'node:crypto';
import { timingSafeEqual } from './_shared/crypto.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

async function resolveVerifyToken(ctx) {
  const envToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();

  try {
    const data = await ctx.q(
      'SELECT whatsapp_webhook_verify_token FROM public.phone_verification_settings WHERE id=$1',
      [SETTINGS_ID],
    ).then((r) => r[0]);
    const dbToken = data?.whatsapp_webhook_verify_token;
    return dbToken?.trim() || null;
  } catch {
    return null;
  }
}

function computeSignature(rawBody, appSecret) {
  return crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

async function handleGet(req, res, ctx) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!mode && !token && !challenge) {
    return res.status(200).type('text/plain').send('WhatsApp webhook is running');
  }

  if (mode !== 'subscribe') {
    return res.status(400).type('text/plain').send("Bad Request: hub.mode must be 'subscribe'");
  }

  if (!token || !challenge) {
    return res.status(400).type('text/plain').send('Bad Request: missing hub.verify_token or hub.challenge');
  }

  const savedToken = await resolveVerifyToken(ctx);

  if (!savedToken) {
    console.error('whatsapp-webhook: no verify token configured');
    return res.status(403).type('text/plain').send('Forbidden: verify token not configured');
  }

  if (token !== savedToken) {
    console.error('whatsapp-webhook: token mismatch');
    return res.status(403).type('text/plain').send('Forbidden: token mismatch');
  }

  ctx.q(
    `UPDATE public.phone_verification_settings SET whatsapp_webhook_last_verified_at=now(), whatsapp_webhook_status='configured' WHERE id=$1`,
    [SETTINGS_ID],
  ).catch(() => {});

  return res.status(200).type('text/plain').send(challenge);
}

async function handlePost(req, res, ctx) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  let body = {};
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Non-JSON body: still return 200 so Meta doesn't retry endlessly.
  }

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret || !appSecret.trim()) {
    console.error('whatsapp-webhook: WHATSAPP_APP_SECRET non défini — rejet du webhook (fail-closed)');
    return res.status(403).json({ error: 'Webhook not configured' });
  }

  const received = req.headers['x-hub-signature-256'] || '';
  const expected = computeSignature(rawBody, appSecret.trim());

  if (!received.startsWith('sha256=')) {
    console.error('whatsapp-webhook: missing or malformed x-hub-signature-256');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const receivedHex = received.slice('sha256='.length);
  if (!timingSafeEqual(receivedHex, expected)) {
    console.error('whatsapp-webhook: signature mismatch');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const object = body.object ?? 'unknown';
  let eventType = object;

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msgs = changes?.value?.messages;
    const statuses = changes?.value?.statuses;
    if (msgs?.length) eventType = 'message';
    else if (statuses?.length) eventType = 'status';
  } catch { /* ignore */ }

  Promise.allSettled([
    ctx.q(`INSERT INTO public.whatsapp_webhook_events (event_type, payload) VALUES ($1,$2)`, [eventType, JSON.stringify(body)]),
    ctx.q(`UPDATE public.phone_verification_settings SET whatsapp_webhook_last_event_at=now() WHERE id=$1`, [SETTINGS_ID]),
  ]).catch(() => {});

  return res.status(200).json({ ok: true });
}

export default async function whatsappWebhook(req, res, ctx) {
  try {
    if (req.method === 'GET') return await handleGet(req, res, ctx);
    if (req.method === 'POST') return await handlePost(req, res, ctx);
    return res.status(405).type('text/plain').send('Method Not Allowed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error('whatsapp-webhook error:', msg);
    return res.status(500).json({ error: msg });
  }
}
