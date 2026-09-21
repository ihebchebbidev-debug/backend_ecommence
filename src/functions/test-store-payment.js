// Port of supabase/functions/test-store-payment/index.ts
import { json, methodGuard } from './_shared/respond.js';
import { paymentKey, decryptJson } from './_shared/crypto.js';

export default async function testStorePayment(req, res, ctx) {
  if (methodGuard(req, res)) return;

  const body = req.body || {};
  const store_id = body.store_id;
  const provider = body.provider;
  if (!store_id || !provider) return json(res, { ok: false, message: 'Paramètres manquants' }, 400);

  if (!ctx.userId) return json(res, { ok: false, message: 'Non authentifié' }, 401);

  const profile = await ctx.profile();
  if (profile?.deleted_at || profile?.status === 'deleted') return json(res, { ok: false, message: 'Compte supprimé' }, 403);
  if (profile?.suspended_at || profile?.status === 'suspended') return json(res, { ok: false, message: 'Compte suspendu' }, 403);

  const isSuperAdmin = await ctx.isSuperAdmin();
  if (!isSuperAdmin) {
    const member = await ctx.q(
      'SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2',
      [store_id, ctx.userId],
    ).then((r) => r[0]);
    if (!member) return json(res, { ok: false, message: 'Accès refusé au magasin' }, 403);
  }

  const integration = await ctx.q(
    'SELECT id, credentials_encrypted, credentials_iv FROM public.store_payment_integrations WHERE store_id=$1 AND provider=$2',
    [store_id, provider],
  ).then((r) => r[0]);

  if (!integration || !integration.credentials_encrypted || !integration.credentials_iv) {
    return json(res, { ok: false, message: 'Aucun identifiant configuré' }, 400);
  }

  let creds = {};
  try {
    creds = decryptJson(paymentKey(), integration.credentials_encrypted, integration.credentials_iv);
  } catch {
    return json(res, { ok: false, message: 'Erreur de déchiffrement des identifiants' }, 500);
  }

  let ok = false;
  let message = '';

  if (provider === 'konnect') {
    const apiKey = creds.api_key || '';
    if (!apiKey) {
      message = 'Clé API Konnect manquante';
    } else {
      try {
        const apiRes = await fetch('https://api.konnect.network/api/v2/wallets', {
          method: 'GET',
          headers: { 'x-api-key': apiKey },
        });
        ok = apiRes.ok;
        if (apiRes.ok) message = creds.receiver_wallet_id ? 'Connexion Konnect réussie' : 'Connexion OK (wallet non défini)';
        else {
          const txt = await apiRes.text().catch(() => '');
          message = `Konnect HTTP ${apiRes.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`;
        }
      } catch (e) {
        message = `Erreur réseau: ${e instanceof Error ? e.message : 'unknown'}`;
      }
    }
  } else if (provider === 'paymee') {
    const apiKey = creds.api_key || '';
    if (!apiKey) {
      message = 'Clé API Paymee manquante';
    } else {
      ok = apiKey.length >= 10;
      message = ok ? 'Clé Paymee présente (validation format)' : 'Clé Paymee invalide';
    }
  }

  const status = ok ? 'connected' : 'error';
  await ctx.q(
    `UPDATE public.store_payment_integrations SET connection_status=$1, last_tested_at=now() WHERE id=$2`,
    [status, integration.id],
  );

  return json(res, { ok, message, status }, 200);
}
