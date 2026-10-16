import { json, methodGuard } from './_shared/respond.js';
import { decryptDeliveryCredentials, canEncryptDelivery, buildAuthHeaders, extractFirstMatch, mapStatus, assertAccountAndStore, deliveryResponseError, sendProviderRequest, deepReplace } from './_shared/delivery.js';

const rateLimitMap = new Map();
function checkRateLimit(storeId, providerCode) {
  const key = `${storeId}:${providerCode}`;
  const now = Date.now();
  const last = rateLimitMap.get(key);
  if (last && now - last < 1000) return false;
  rateLimitMap.set(key, now);
  return true;
}

export default async function trackDeliveryShipment(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);
  const { store_id, shipment_id } = req.body || {};
  if (!(await assertAccountAndStore(ctx, res, store_id))) return;

  const shipment = await ctx.q('SELECT * FROM public.delivery_shipments WHERE id=$1 AND store_id=$2', [shipment_id, store_id]).then((r) => r[0]);
  if (!shipment) return json(res, { error: 'Expédition introuvable' }, 404);
  if (!shipment.tracking_number) return json(res, { error: 'Aucun numéro de suivi pour cette expédition' }, 400);

  const provider = await ctx.q('SELECT * FROM public.delivery_providers WHERE id=$1', [shipment.provider_id]).then((r) => r[0]);
  if (!provider) return json(res, { error: 'Provider introuvable' }, 404);
  if (!provider.supports_tracking || provider.integration_mode === 'manual') return json(res, { error: 'Automatic tracking is unavailable for this carrier. Update the status manually.', code: 'carrier_tracking_unsupported' }, 400);

  if (!checkRateLimit(store_id, provider.code)) return json(res, { error: 'Veuillez patienter avant de relancer la synchronisation.' }, 429);

  const integration = await ctx.q('SELECT * FROM public.store_delivery_integrations WHERE store_id=$1 AND provider_id=$2', [store_id, provider.id]).then((r) => r[0]);
  if (!integration) return json(res, { error: 'Intégration non configurée' }, 400);

  const secret = await ctx.q('SELECT credentials_ciphertext, credentials_iv, encryption_version FROM public.delivery_integration_secrets WHERE integration_id=$1', [integration.id]).then((r) => r[0]);
  if (!secret) return json(res, { error: 'Token non configuré' }, 400);
  if (!canEncryptDelivery()) return json(res, { error: 'Delivery encryption key missing' }, 500);
  if (secret.encryption_version === 'legacy-xor-v0') return json(res, { error: 'Token non configuré' }, 400);

  let credentials;
  try { credentials = decryptDeliveryCredentials(secret.credentials_ciphertext, secret.credentials_iv); }
  catch { return json(res, { error: 'Token non configuré' }, 400); }

  const payload = provider.tracking_payload_template && Object.keys(provider.tracking_payload_template).length
    ? deepReplace(provider.tracking_payload_template, { shipment, credentials })
    : { barCode: shipment.tracking_number };

  const endpoint = provider.track_shipment_endpoint || (payload.__format === 'colissimo_soap' ? '' : provider.code === 'first_delivery' ? '/etat' : null);
  if (endpoint === null) return json(res, { error: 'Carrier tracking endpoint is not configured' }, 400);
  const { res: apiRes, data } = await sendProviderRequest(provider, credentials, endpoint, payload, 15000);
  if (!apiRes.ok) return json(res, { error: deliveryResponseError(data) || `Erreur API: HTTP ${apiRes.status}` }, 502);
  if (!data || !Object.keys(data).length || deliveryResponseError(data)) return json(res, { error: deliveryResponseError(data) || 'Réponse suivi invalide' }, 502);

  const m = provider.response_mapping || {};
  const statusPaths = [m.status, 'result.state', 'result.etat', 'result.status', 'data.state', 'data.status', 'result_content.etat', 'TrackingResults.0.Value.0.UpdateCode', 'state', 'etat', 'status'].filter(Boolean);
  const rawStatus = extractFirstMatch(data, statusPaths);
  if (rawStatus == null) return json(res, { error: 'Aucun statut retourné par le transporteur' }, 502);
  const mappedStatus = mapStatus(provider.status_mapping || {}, rawStatus);

  await ctx.q(`UPDATE public.delivery_shipments SET status=$1, updated_at=now() WHERE id=$2`, [mappedStatus, shipment_id]);
  await ctx.q(
    `INSERT INTO public.delivery_tracking_events (shipment_id, store_id, event_type, status, description, raw_data) VALUES ($1,$2,'tracking_update',$3,$4,$5)`,
    [shipment_id, store_id, mappedStatus, `Suivi: ${rawStatus} → ${mappedStatus}`, JSON.stringify(data)],
  );

  return json(res, { success: true, status: mappedStatus, raw_status: rawStatus });
}
