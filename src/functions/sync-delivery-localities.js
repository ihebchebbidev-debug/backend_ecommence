import { json, methodGuard } from './_shared/respond.js';
import { decryptDeliveryCredentials, canEncryptDelivery, buildAuthHeaders, assertAccountAndStore } from './_shared/delivery.js';

function localizedError(status) {
  if (status === 401 || status === 403) return 'Token First Delivery invalide ou expiré. Veuillez générer un nouveau token depuis votre compte First Delivery > API.';
  if (status === 404) return 'Endpoint First Delivery introuvable. Vérifiez base_url et /localities.';
  return `Erreur API First Delivery: HTTP ${status}`;
}

export default async function syncDeliveryLocalities(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);
  const { store_id, provider_code, test_only } = req.body || {};
  if (!(await assertAccountAndStore(ctx, res, store_id))) return;

  const provider = await ctx.q('SELECT * FROM public.delivery_providers WHERE code=$1', [provider_code]).then((r) => r[0]);
  if (!provider) return json(res, { error: 'Provider introuvable' }, 404);
  if (!provider.is_active) return json(res, { error: 'Provider désactivé' }, 403);

  const integration = await ctx.q('SELECT * FROM public.store_delivery_integrations WHERE store_id=$1 AND provider_id=$2', [store_id, provider.id]).then((r) => r[0]);
  if (!integration) return json(res, { error: 'Intégration non configurée' }, 400);
  if (!test_only && (!integration.enabled || integration.status !== 'connected')) return json(res, { error: 'Intégration non connectée' }, 400);

  const secret = await ctx.q('SELECT credentials_ciphertext, credentials_iv, encryption_version FROM public.delivery_integration_secrets WHERE integration_id=$1', [integration.id]).then((r) => r[0]);
  if (!secret) return json(res, { error: 'Token non configuré' }, 400);
  if (!canEncryptDelivery()) return json(res, { error: 'Delivery encryption key missing' }, 500);
  if (secret.encryption_version === 'legacy-xor-v0') return json(res, { error: 'Token non configuré' }, 400);

  let credentials;
  try { credentials = decryptDeliveryCredentials(secret.credentials_ciphertext, secret.credentials_iv); }
  catch { return json(res, { error: 'Token non configuré' }, 400); }

  const localitiesUrl = `${provider.base_url}${provider.localities_endpoint || '/localities'}`;
  const headers = buildAuthHeaders(provider, credentials);

  let apiRes;
  try {
    apiRes = await fetch(localitiesUrl, { method: 'GET', headers, signal: AbortSignal.timeout(30000) });
  } catch {
    return json(res, { error: 'Impossible de contacter First Delivery. Veuillez réessayer.' }, 502);
  }

  if (!apiRes.ok) {
    await ctx.q(
      `UPDATE public.store_delivery_integrations SET status='error', last_error=$1, updated_at=now() WHERE id=$2`,
      [localizedError(apiRes.status), integration.id],
    );
    return json(res, { error: localizedError(apiRes.status), status: apiRes.status }, 502);
  }

  if (test_only) {
    await ctx.q(`UPDATE public.store_delivery_integrations SET status='connected', last_error=NULL, updated_at=now() WHERE id=$1`, [integration.id]);
    return json(res, { success: true, ok: true, synced: 0 });
  }

  const data = await apiRes.json().catch(() => ({}));
  const localities = Array.isArray(data) ? data : Array.isArray(data.result) ? data.result : Array.isArray(data.data) ? data.data : [];
  if (localities.length === 0) return json(res, { error: 'Aucune localité retournée par First Delivery' }, 502);

  let syncedCount = 0;
  for (const loc of localities) {
    const localityId = loc.locality_id ?? loc.id ?? loc.localityId;
    if (localityId == null) continue;
    try {
      await ctx.q(
        `INSERT INTO public.delivery_provider_localities (provider_code, locality_id, locality_name, delegation_name, governorate_name, raw_payload, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (provider_code, locality_id) DO UPDATE SET locality_name=EXCLUDED.locality_name, delegation_name=EXCLUDED.delegation_name, governorate_name=EXCLUDED.governorate_name, raw_payload=EXCLUDED.raw_payload, updated_at=now()`,
        [provider.code, Number(localityId), loc.locality_name ?? loc.name ?? null, loc.delegation_name ?? null, loc.governorate_name ?? null, JSON.stringify(loc)],
      );
      syncedCount++;
    } catch { /* skip failed rows, mirrors upsertErr check */ }
  }

  await ctx.q(
    `UPDATE public.store_delivery_integrations SET localities_last_synced_at=now(), status='connected', last_error=NULL, updated_at=now() WHERE id=$1`,
    [integration.id],
  );

  return json(res, { success: true, synced: syncedCount, total: localities.length });
}
