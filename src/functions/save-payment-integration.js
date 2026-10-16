// Port of supabase/functions/save-payment-integration/index.ts
import { json, methodGuard } from './_shared/respond.js';

import { canEncryptPaymentCredentials, encryptPaymentJson } from './_shared/paymentCrypto.js';
export { canEncryptPaymentCredentials, encryptPaymentJson, decryptPaymentJson } from './_shared/paymentCrypto.js';

export function maskPaymentCredentials(creds) {
  const result = {};
  for (const [key, value] of Object.entries(creds || {})) {
    if (!value) continue;
    const s = String(value);
    result[key] = s.length <= 4 ? '********' : `${s.slice(0, 2)}****${s.slice(-2)}`;
  }
  return result;
}

const PROVIDER_FIELDS = { konnect: ['api_key', 'receiver_wallet_id'], paymee: ['api_key'] };

export default async function savePaymentIntegration(req, res, ctx) {
  if (methodGuard(req, res)) return;
  const { store_id, provider, credentials, credentials_changed, is_active } = req.body || {};

  if (!store_id || !provider) return json(res, { error: 'Paramètres manquants' }, 400);
  if (!PROVIDER_FIELDS[provider]) return json(res, { error: 'Provider non supporté' }, 400);
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);

  const profile = await ctx.q('SELECT status, deleted_at, suspended_at FROM public.profiles WHERE id=$1', [ctx.userId]).then((r) => r[0]);
  if (profile?.deleted_at || profile?.status === 'deleted') return json(res, { error: 'Compte supprimé' }, 403);
  if (profile?.suspended_at || profile?.status === 'suspended') return json(res, { error: 'Compte suspendu' }, 403);

  const isSuperAdmin = await ctx.isSuperAdmin();
  if (!isSuperAdmin) {
    const member = await ctx.q(
      'SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND role = ANY($3)',
      [store_id, ctx.userId, ['owner', 'admin']],
    ).then((r) => r[0]);
    if (!member) return json(res, { error: 'Accès refusé au magasin' }, 403);
  }

  const store = await ctx.q('SELECT status FROM public.platform_stores WHERE id=$1', [store_id]).then((r) => r[0]);
  if (!store || store.status !== 'active') return json(res, { error: 'Magasin inactif' }, 403);

  const hasNewCreds = !!credentials_changed && Object.keys(credentials || {}).length > 0;
  if (hasNewCreds) {
    for (const fieldKey of PROVIDER_FIELDS[provider]) {
      if (!credentials?.[fieldKey]) return json(res, { error: `Champ requis manquant: ${fieldKey}` }, 400);
    }
  }

  if (!canEncryptPaymentCredentials()) return json(res, { error: 'Payment encryption key missing' }, 500);

  const existing = await ctx.q(
    'SELECT id, credentials_encrypted, credentials_iv, credentials_version, connection_status FROM public.store_payment_integrations WHERE store_id=$1 AND provider=$2',
    [store_id, provider],
  ).then((r) => r[0]);

  let encrypted = null;
  if (hasNewCreds) encrypted = encryptPaymentJson(credentials);

  const hasCreds = hasNewCreds || !!existing?.credentials_encrypted;
  if (is_active && !hasCreds) return json(res, { error: 'Identifiants de paiement requis' }, 400);
  const masked = hasNewCreds ? maskPaymentCredentials(credentials) : {};

  let connectionStatus;
  if (!is_active) {
    connectionStatus = existing?.connection_status || 'unknown';
  } else if (hasNewCreds) {
    connectionStatus = 'configured';
  } else if (existing?.connection_status === 'connected') {
    connectionStatus = 'connected';
  } else {
    connectionStatus = existing?.connection_status || 'unknown';
  }

  const credsEncrypted = encrypted ? encrypted.ciphertext : (existing?.credentials_encrypted || null);
  const credsIv = encrypted ? encrypted.iv : (existing?.credentials_iv || null);
  const credsVersion = encrypted ? encrypted.version : (existing?.credentials_version || null);

  let integrationId;
  if (existing) {
    const updated = await ctx.one(
      `UPDATE public.store_payment_integrations SET
         credentials_encrypted=$1, credentials_iv=$2, credentials_version=$3, is_active=$4,
         connection_status=$5, updated_at=now()
       WHERE id=$6 RETURNING id`,
      [credsEncrypted, credsIv, credsVersion, is_active, connectionStatus, existing.id],
    );
    integrationId = updated.id;
  } else {
    const created = await ctx.one(
      `INSERT INTO public.store_payment_integrations
         (store_id, provider, credentials_encrypted, credentials_iv, credentials_version, is_active, connection_status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING id`,
      [store_id, provider, credsEncrypted, credsIv, credsVersion, is_active, connectionStatus],
    );
    integrationId = created.id;
  }

  return json(res, {
    success: true,
    id: integrationId,
    provider,
    is_active,
    connection_status: connectionStatus,
    has_credentials: hasCreds,
    masked_credentials: masked,
  });
}
