// Sends phone notifications for new commerce notifications through the Expo push service.
// Permission is re-checked per device on every tick with the same rules as the in-app inbox,
// and messages carry no customer details (only the event kind and order number).
import { makeContext } from './context.js';
import { allowedTypes } from '../rpc/notifications.js';
import { pushMessage } from './pushMessages.js';

export { pushMessage };

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const WINDOW_MINUTES = 15;

export async function deliverPush(q, log, send = defaultSend) {
  const devices = await q('SELECT id,user_id,store_id,token,language,created_at FROM public.push_devices WHERE revoked_at IS NULL');
  for (const device of devices) {
    let types;
    try { types = await allowedTypes(makeContext({ userId: device.user_id, role: 'authenticated' }), device.store_id); }
    catch { continue; } // access lost: send nothing (the device is kept until the owner signs out)
    if (!types.length) continue;
    const fresh = await q(`SELECT n.id,n.type,n.source_id,n.store_id,n.data FROM public.commerce_notifications n
      WHERE n.store_id=$1 AND n.type=ANY($2::text[]) AND n.created_at >= GREATEST($3::timestamptz, now() - ($4 || ' minutes')::interval)
      AND NOT EXISTS (SELECT 1 FROM public.push_deliveries d WHERE d.notification_id=n.id AND d.device_id=$5)
      ORDER BY n.created_at LIMIT 20`, [device.store_id, types, device.created_at, String(WINDOW_MINUTES), device.id]);
    const messages = [];
    for (const n of fresh) {
      const claimed = await q('INSERT INTO public.push_deliveries(notification_id,device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING notification_id', [n.id, device.id]);
      if (claimed.length) messages.push(pushMessage(device, n));
    }
    if (!messages.length) continue;
    try {
      const tickets = await send(messages);
      if (tickets.some(t => t?.details?.error === 'DeviceNotRegistered')) await q('UPDATE public.push_devices SET revoked_at=now() WHERE id=$1', [device.id]);
    } catch (e) { log?.warn?.('push send failed', { message: e.message }); }
  }
}

async function defaultSend(messages) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const res = await fetch(EXPO_URL, { method: 'POST', headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.data) ? body.data : [];
}

export function startPushWorker(q, log, everyMs = 20000) {
  if (process.env.PUSH_NOTIFICATIONS === 'false') return () => {};
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await deliverPush(q, log); } catch (e) { log?.warn?.('push worker failed', { message: e.message }); }
    finally { running = false; }
  };
  const t = setInterval(tick, everyMs); t.unref?.();
  return () => clearInterval(t);
}
