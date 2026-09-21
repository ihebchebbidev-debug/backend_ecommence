// Port of supabase/functions/save-delivery-integration/index.ts
import { json, methodGuard } from './_shared/respond.js';
import { deliveryKey, canEncrypt, encryptJson } from './_shared/crypto.js';
import { checkSuperAdmin } from './_shared/delivery.js';

/** Deno original mask: first2 + stars + last2 (or all-stars when <=4 chars). */
function maskCredentials(creds) {
  const result = {};
  for (const [key, value] of Object.entries(creds || {})) {
    if (!value) continue;
    const s = String(value);
    result[key] = s.length <= 4 ? '********' : `${s.slice(0, 2)}****${s.slice(-2)}`;
  }
  return result;
}

export default async function saveDeliveryIntegration(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);

  const {
    store_id, provider_id, credentials, sender_config, provider_settings,
    enabled, delivery_cost_tnd, return_cost_tnd, tracking_enabled, label_enabled,
    default_provider, test_mode,
  } = req.body || {};

  // ── Check user status ──
  const profile = await ctx.q('SELECT status, deleted_at, suspended_at FROM public.profiles WHERE id=$1', [ctx.userId]).then((r) => r[0]);
  if (profile?.deleted_at || profile?.status === 'deleted') return json(res, { error: 'Compte supprimé' }, 403);
  if (profile?.suspended_at || profile?.status === 'suspended') return json(res, { error: 'Compte suspendu' }, 403);

  // ── Check store access (owner/admin) ──
  const isSuperAdmin = await checkSuperAdmin(ctx, ctx.userId);
  if (!isSuperAdmin) {
    const member = await ctx.q(
      `SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND role = ANY($3)`,
      [store_id, ctx.userId, ['owner', 'admin']],
    ).then((r) => r[0]);
    if (!member) return json(res, { error: 'Accès refusé au magasin' }, 403);
  }

  // ── Check store is active ──
  const store = await ctx.q('SELECT status FROM public.platform_stores WHERE id=$1', [store_id]).then((r) => r[0]);
  if (!store || store.status !== 'active') return json(res, { error: 'Magasin inactif' }, 403);

  // ── Load provider ──
  const provider = await ctx.q('SELECT * FROM public.delivery_providers WHERE id=$1', [provider_id]).then((r) => r[0]);
  if (!provider) return json(res, { error: 'Provider introuvable' }, 404);
  if (!provider.is_active) return json(res, { error: 'Provider désactivé' }, 403);

  // ── Validate required credential fields (only when new credentials given) ──
  const credSchema = provider.credentials_schema?.fields || [];
  const hasNewCredsPre = Object.keys(credentials || {}).length > 0;
  if (hasNewCredsPre) {
    for (const field of credSchema) {
      if (field.required && !credentials?.[field.key]) return json(res, { error: `Champ requis manquant: ${field.key}` }, 400);
    }
  }

  // ── Validate required sender fields ──
  const senderSchema = provider.sender_schema?.fields || [];
  for (const field of senderSchema) {
    if (field.required && !sender_config?.[field.key]) return json(res, { error: `Champ expéditeur requis manquant: ${field.key}` }, 400);
  }

  // ── Check encryption key configured ──
  const key = deliveryKey();
  if (!canEncrypt(key)) return json(res, { error: 'Delivery encryption key missing' }, 500);

  const hasNewCreds = hasNewCredsPre;
  let encrypted = null;
  if (hasNewCreds) encrypted = encryptJson(key, credentials);

  // ── Load existing integration ──
  const existing = await ctx.q(
    `SELECT id, has_credentials, masked_credentials, status, last_error, last_test_at
     FROM public.store_delivery_integrations WHERE store_id=$1 AND provider_id=$2`,
    [store_id, provider_id],
  ).then((r) => r[0]);

  let hasCreds = hasNewCreds;
  let masked = hasNewCreds ? maskCredentials(credentials) : {};
  if (!hasNewCreds && existing?.has_credentials) {
    hasCreds = true;
    masked = existing.masked_credentials || {};
  }

  const credentialsChanged = hasNewCreds;
  let status;
  if (!enabled) {
    status = existing?.status || 'not_configured';
  } else if (provider.integration_mode === 'manual') {
    status = 'connected';
  } else if (!provider.base_url) {
    status = 'error';
  } else if (credentialsChanged) {
    status = 'configured';
  } else if (existing?.status === 'connected') {
    status = 'connected';
  } else if (hasCreds) {
    status = existing?.status || 'configured';
  } else {
    status = 'not_configured';
  }

  const trackingEnabled = tracking_enabled !== false;
  const labelEnabled = label_enabled !== false;
  const testMode = test_mode !== false;
  const lastError = credentialsChanged ? null : (status === 'error' ? 'Configuration invalide' : (existing?.last_error ?? null));

  let integrationId;
  if (existing) {
    const updated = await ctx.one(
      `UPDATE public.store_delivery_integrations SET
         provider_code=$1, enabled=$2, status=$3, has_credentials=$4, masked_credentials=$5,
         sender_config=$6, provider_settings=$7, delivery_cost_tnd=$8, return_cost_tnd=$9,
         default_provider=$10, tracking_enabled=$11, label_enabled=$12, test_mode=$13,
         last_test_at=$14, last_error=$15, updated_at=now()
       WHERE id=$16 RETURNING id`,
      [
        provider.code, enabled, status, hasCreds, JSON.stringify(masked), JSON.stringify(sender_config || {}),
        JSON.stringify(provider_settings || {}), delivery_cost_tnd || 0, return_cost_tnd || 0,
        default_provider || false, trackingEnabled, labelEnabled, testMode,
        existing.last_test_at || null, lastError, existing.id,
      ],
    );
    integrationId = updated.id;
  } else {
    const created = await ctx.one(
      `INSERT INTO public.store_delivery_integrations
         (store_id, provider_id, provider_code, enabled, status, has_credentials, masked_credentials,
          sender_config, provider_settings, delivery_cost_tnd, return_cost_tnd, default_provider,
          tracking_enabled, label_enabled, test_mode, last_test_at, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       RETURNING id`,
      [
        store_id, provider_id, provider.code, enabled, status, hasCreds, JSON.stringify(masked),
        JSON.stringify(sender_config || {}), JSON.stringify(provider_settings || {}), delivery_cost_tnd || 0,
        return_cost_tnd || 0, default_provider || false, trackingEnabled, labelEnabled, testMode,
        null, lastError,
      ],
    );
    integrationId = created.id;
  }

  // ── Upsert encrypted secrets in separate table ──
  if (encrypted) {
    const existingSecret = await ctx.q(
      'SELECT id FROM public.delivery_integration_secrets WHERE integration_id=$1',
      [integrationId],
    ).then((r) => r[0]);

    if (existingSecret) {
      await ctx.q(
        `UPDATE public.delivery_integration_secrets SET
           store_id=$1, provider_id=$2, credentials_ciphertext=$3, credentials_iv=$4,
           credentials_tag=NULL, encryption_version=$5, updated_at=now()
         WHERE id=$6`,
        [store_id, provider_id, encrypted.ciphertext, encrypted.iv, encrypted.version, existingSecret.id],
      );
    } else {
      await ctx.q(
        `INSERT INTO public.delivery_integration_secrets
           (integration_id, store_id, provider_id, credentials_ciphertext, credentials_iv, credentials_tag, encryption_version, updated_at)
         VALUES ($1,$2,$3,$4,$5,NULL,$6, now())`,
        [integrationId, store_id, provider_id, encrypted.ciphertext, encrypted.iv, encrypted.version],
      );
    }
  }

  // ── If default_provider, unset default on other integrations ──
  if (default_provider) {
    await ctx.q(
      'UPDATE public.store_delivery_integrations SET default_provider=false WHERE store_id=$1 AND id<>$2',
      [store_id, integrationId],
    );
  }

  return json(res, {
    success: true,
    provider_code: provider.code,
    status,
    enabled,
    has_credentials: hasCreds,
    masked_credentials: masked,
  });
}
