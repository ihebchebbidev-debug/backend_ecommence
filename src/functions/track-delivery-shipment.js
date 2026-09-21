import { json, methodGuard } from './_shared/respond.js';
import { decryptDeliveryCredentials, canEncryptDelivery, buildAuthHeaders, extractFirstMatch, mapStatus, assertAccountAndStore } from './_shared/delivery.js';

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

  const trackingUrl = `${provider.base_url}${provider.track_shipment_endpoint || '/etat'}`;
  const headers = buildAuthHeaders(provider, credentials);

  let payload;
  if (provider.tracking_payload_template) {
    payload = JSON.parse(JSON.stringify(provider.tracking_payload_template).replace(/\{\{shipment\.tracking_number\}\}/g, shipment.tracking_number));
  } else {
    payload = { barCode: shipment.tracking_number };
  }

  const apiRes = await fetch(trackingUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok) return json(res, { error: `Erreur API: HTTP ${apiRes.status}` }, 502);

  const m = provider.response_mapping || {};
  const statusPaths = [m.status, 'result.state', 'result.etat', 'result.status', 'data.state', 'data.status', 'state', 'status'].filter(Boolean);
  const rawStatus = extractFirstMatch(data, statusPaths) || 'in_transit';
  const mappedStatus = mapStatus(provider.status_mapping || {}, rawStatus);

  await ctx.q(`UPDATE public.delivery_shipments SET status=$1, updated_at=now() WHERE id=$2`, [mappedStatus, shipment_id]);
  await ctx.q(
    `INSERT INTO public.delivery_tracking_events (shipment_id, store_id, event_type, status, description, raw_data) VALUES ($1,$2,'tracking_update',$3,$4,$5)`,
    [shipment_id, store_id, mappedStatus, `Suivi: ${rawStatus} → ${mappedStatus}`, JSON.stringify(data)],
  );

  return json(res, { success: true, status: mappedStatus, raw_status: rawStatus });
}
