// Seller Zapier / Make webhooks: read status, save, remove and send a test event.
import { json, methodGuard } from './_shared/respond.js';
import { assertAccountAndStore } from './_shared/delivery.js';
import { validWebhookUrl, postWebhook } from '../lib/automationWebhooks.js';

const mask = (url) => { try { const u = new URL(url); return `${u.origin}/…${u.pathname.slice(-4)}`; } catch { return ''; } };

export default async function automationWebhooks(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);
  const { store_id, action, provider, url } = req.body || {};
  if (!(await assertAccountAndStore(ctx, res, store_id, ['owner', 'admin']))) return;

  if (action === 'list') {
    const rows = await ctx.q('SELECT provider, url, enabled, last_status, last_error, last_sent_at FROM public.store_automation_webhooks WHERE store_id=$1', [store_id]);
    return json(res, { webhooks: rows.map((r) => ({ ...r, url: mask(r.url) })) });
  }
  if (!['zapier', 'make'].includes(provider)) return json(res, { error: 'Fournisseur inconnu' }, 400);

  if (action === 'save') {
    if (!validWebhookUrl(provider, url)) return json(res, { error: 'invalid_url' }, 400);
    await ctx.q(`INSERT INTO public.store_automation_webhooks(store_id, provider, url, enabled) VALUES ($1,$2,$3,true)
      ON CONFLICT (store_id, provider) DO UPDATE SET url=EXCLUDED.url, enabled=true, last_error=NULL, last_status=NULL, updated_at=now()`,
      [store_id, provider, String(url).trim()]);
    return json(res, { ok: true });
  }
  if (action === 'remove') {
    await ctx.q('DELETE FROM public.store_automation_webhooks WHERE store_id=$1 AND provider=$2', [store_id, provider]);
    return json(res, { ok: true });
  }
  if (action === 'test') {
    const row = await ctx.q('SELECT id, url FROM public.store_automation_webhooks WHERE store_id=$1 AND provider=$2', [store_id, provider]).then((r) => r[0]);
    if (!row) return json(res, { error: 'not_configured' }, 400);
    const result = await postWebhook(row.url, { event: 'test', store_id, sent_at: new Date().toISOString(), order: {
      id: '00000000-0000-0000-0000-000000000000', order_number: 'TEST-0001', status: 'pending', amount: 59.9, currency: 'TND',
      customer_name: 'Test Client', customer_phone: '+21620000000', city: 'Tunis', product_name: 'Produit test', quantity: 1 } });
    await ctx.q('UPDATE public.store_automation_webhooks SET last_status=$2, last_error=$3, last_sent_at=now() WHERE id=$1',
      [row.id, result.status, result.ok ? null : (result.error || `HTTP ${result.status}`)]);
    return json(res, { ok: result.ok, status: result.status });
  }
  return json(res, { error: 'Action inconnue' }, 400);
}
