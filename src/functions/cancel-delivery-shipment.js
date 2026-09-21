import { json, methodGuard } from './_shared/respond.js';
import { decryptDeliveryCredentials, canEncryptDelivery, buildAuthHeaders, assertAccountAndStore } from './_shared/delivery.js';

export default async function cancelDeliveryShipment(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);
  const { store_id, shipment_id } = req.body || {};
  if (!(await assertAccountAndStore(ctx, res, store_id))) return;

  const shipment = await ctx.q('SELECT * FROM public.delivery_shipments WHERE id=$1 AND store_id=$2', [shipment_id, store_id]).then((r) => r[0]);
  if (!shipment) return json(res, { error: 'Expédition introuvable' }, 404);
  if (!shipment.tracking_number) return json(res, { error: 'Aucun numéro de suivi pour annuler' }, 400);
  if (!['created', 'pending', 'picked_up'].includes(shipment.status)) return json(res, { error: 'Cette expédition ne peut plus être annulée' }, 400);

  const provider = await ctx.q('SELECT * FROM public.delivery_providers WHERE id=$1', [shipment.provider_id]).then((r) => r[0]);
  if (!provider) return json(res, { error: 'Provider introuvable' }, 404);

  const integration = await ctx.q('SELECT * FROM public.store_delivery_integrations WHERE store_id=$1 AND provider_id=$2', [store_id, provider.id]).then((r) => r[0]);
  if (!integration) return json(res, { error: 'Intégration non configurée' }, 400);

  const secret = await ctx.q('SELECT credentials_ciphertext, credentials_iv, encryption_version FROM public.delivery_integration_secrets WHERE integration_id=$1', [integration.id]).then((r) => r[0]);
  if (!secret) return json(res, { error: 'Token non configuré' }, 400);
  if (!canEncryptDelivery()) return json(res, { error: 'Delivery encryption key missing' }, 500);
  if (secret.encryption_version === 'legacy-xor-v0') return json(res, { error: 'Token non configuré' }, 400);

  let credentials;
  try { credentials = decryptDeliveryCredentials(secret.credentials_ciphertext, secret.credentials_iv); }
  catch { return json(res, { error: 'Token non configuré' }, 400); }

  const cancelUrl = `${provider.base_url}${provider.cancel_shipment_endpoint || '/cancel-orders'}`;
  const headers = buildAuthHeaders(provider, credentials);
  const payload = { barCodes: [shipment.tracking_number] };

  const apiRes = await fetch(cancelUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok) return json(res, { error: `Erreur annulation API: HTTP ${apiRes.status}` }, 502);

  await ctx.q(`UPDATE public.delivery_shipments SET status='cancelled', updated_at=now() WHERE id=$1`, [shipment_id]);
  await ctx.q(
    `INSERT INTO public.delivery_tracking_events (shipment_id, store_id, event_type, status, description, raw_data) VALUES ($1,$2,'cancel_api','cancelled','Annulation via API First Delivery',$3)`,
    [shipment_id, store_id, JSON.stringify(data)],
  );

  return json(res, { success: true, status: 'cancelled' });
}
