// Delivers order events to seller Zapier / Make webhooks from the automation_events outbox.
export const WEBHOOK_HOSTS = { zapier: ['hooks.zapier.com'], make: ['hook.eu1.make.com', 'hook.eu2.make.com', 'hook.us1.make.com', 'hook.us2.make.com', 'hook.make.com', 'hook.integromat.com'] };

/** Only official HTTPS hook hosts are accepted, so the server never posts to arbitrary/internal addresses. */
export function validWebhookUrl(provider, raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return false; }
  const hosts = WEBHOOK_HOSTS[provider];
  if (!hosts || u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return hosts.includes(host) || (provider === 'make' && /^hook\.[a-z0-9-]+\.make\.com$/.test(host));
}

/** Exponential backoff in seconds, capped at 1 hour. */
export const retryDelay = (attempts) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
export const MAX_ATTEMPTS = 8;

export async function postWebhook(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, status: 0, error: e?.message || 'network' }; }
}

export async function deliverPending(q, log) {
  const events = await q(`SELECT id, store_id, event, data, attempts FROM public.automation_events
    WHERE delivered_at IS NULL AND attempts < $1 AND next_attempt_at <= now() ORDER BY id LIMIT 50`, [MAX_ATTEMPTS]);
  for (const ev of events) {
    const hooks = await q('SELECT id, provider, url FROM public.store_automation_webhooks WHERE store_id=$1 AND enabled', [ev.store_id]);
    let allOk = true;
    for (const h of hooks) {
      const res = await postWebhook(h.url, { event: ev.event, store_id: ev.store_id, sent_at: new Date().toISOString(), order: ev.data });
      allOk &&= res.ok;
      await q('UPDATE public.store_automation_webhooks SET last_status=$2, last_error=$3, last_sent_at=now() WHERE id=$1',
        [h.id, res.status, res.ok ? null : (res.error || `HTTP ${res.status}`)]);
    }
    const attempts = ev.attempts + 1;
    if (allOk) await q('UPDATE public.automation_events SET delivered_at=now(), attempts=$2 WHERE id=$1', [ev.id, attempts]);
    else await q(`UPDATE public.automation_events SET attempts=$2, next_attempt_at=now() + make_interval(secs => $3) WHERE id=$1`, [ev.id, attempts, retryDelay(attempts)]);
  }
  if (events.length) log?.debug?.('automation webhooks', { processed: events.length });
  // Keep the outbox small.
  await q(`DELETE FROM public.automation_events WHERE created_at < now() - interval '14 days'`);
}

export function startAutomationWorker(q, log, everyMs = 15000) {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await deliverPending(q, log); } catch (e) { log?.warn?.('automation webhook worker failed', { message: e.message }); }
    finally { running = false; }
  };
  const t = setInterval(tick, everyMs); t.unref?.();
  return () => clearInterval(t);
}
