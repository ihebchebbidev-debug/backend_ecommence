// Port of supabase/functions/test-store-payment/index.ts
import { json, methodGuard } from './_shared/respond.js';
import { decryptPaymentJson } from './_shared/paymentCrypto.js';

export default async function testStorePayment(req, res, ctx) {
  if (methodGuard(req, res)) return;

  const body = req.body || {};
  const store_id = body.store_id;
  const provider = body.provider;
  if (!store_id || !provider) return json(res, { ok: false, message: 'Paramètres manquants' }, 400);

  if (!['konnect', 'paymee', 'flouci', 'stripe'].includes(provider)) return json(res, { ok: false, message: 'Provider non supporté' }, 400);

  if (!ctx.userId) return json(res, { ok: false, message: 'Non authentifié' }, 401);

  const profile = await ctx.profile();
  if (profile?.deleted_at || profile?.status === 'deleted') return json(res, { ok: false, message: 'Compte supprimé' }, 403);
  if (profile?.suspended_at || profile?.status === 'suspended') return json(res, { ok: false, message: 'Compte suspendu' }, 403);

  const isSuperAdmin = await ctx.isSuperAdmin();
  if (!isSuperAdmin) {
    const member = await ctx.q(
      'SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND role = ANY($3)',
      [store_id, ctx.userId, ['owner', 'admin']],
    ).then((r) => r[0]);
    if (!member) return json(res, { ok: false, message: 'Accès refusé au magasin' }, 403);
  }

  const integration = await ctx.q(
    'SELECT id, credentials_encrypted, credentials_iv, credentials_version FROM public.store_payment_integrations WHERE store_id=$1 AND provider=$2',
    [store_id, provider],
  ).then((r) => r[0]);

  if (!integration || !integration.credentials_encrypted || !integration.credentials_iv) {
    return json(res, { ok: false, message: 'Aucun identifiant configuré' }, 400);
  }

  let creds = {};
  try {
    creds = decryptPaymentJson(integration.credentials_encrypted, integration.credentials_iv, integration.credentials_version);
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
          signal: AbortSignal.timeout(15000),
        });
        ok = apiRes.ok && !!creds.receiver_wallet_id;
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
      // Paymee has no credential-only probe here: format is not a live connection test.
      const validFormat = apiKey.length >= 10;
      message = validFormat ? 'Clé enregistrée ; connexion Paymee non vérifiée. Un paiement sandbox est requis.' : 'Clé Paymee invalide';
      await ctx.q(`UPDATE public.store_payment_integrations SET connection_status=$1, last_tested_at=now() WHERE id=$2`, [validFormat ? 'configured' : 'error', integration.id]);
      return json(res, { ok: false, message, status: validFormat ? 'configured' : 'error', verified: false });
    }
  } else if (provider === 'flouci') {
    const pub = creds.app_public || '';
    const sec = creds.app_secret || '';
    if (!pub || !sec) {
      message = 'Clés Flouci manquantes';
    } else {
      // Flouci has no dedicated "who am I" call: verifying an unknown payment id
      // still authenticates the keys first, so 401/403 means wrong keys.
      try {
        const r = await fetch('https://developers.flouci.com/api/v2/verify_payment/connection-test', {
          headers: { Authorization: `Bearer ${pub}:${sec}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r.status === 401 || r.status === 403) message = 'Clés Flouci refusées (vérifiez la clé publique et la clé privée)';
        else if (r.status >= 500) message = `Flouci indisponible (HTTP ${r.status}), réessayez plus tard`;
        else { ok = true; message = 'Clés Flouci acceptées'; }
      } catch (e) {
        message = `Erreur réseau: ${e instanceof Error ? e.message : 'unknown'}`;
      }
    }
  } else if (provider === 'stripe') {
    const key = creds.secret_key || '';
    if (!key) {
      message = 'Clé secrète Stripe manquante';
    } else {
      try {
        const r = await fetch('https://api.stripe.com/v1/balance', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) { ok = true; message = key.includes('_test_') ? 'Connexion Stripe réussie (mode test)' : 'Connexion Stripe réussie'; }
        else {
          const d = await r.json().catch(() => ({}));
          message = `Stripe HTTP ${r.status}${d?.error?.message ? `: ${d.error.message}` : ''}`;
        }
      } catch (e) {
        message = `Erreur réseau: ${e instanceof Error ? e.message : 'unknown'}`;
      }
    }
  }

  const status = ok ? 'connected' : 'error';
  await ctx.q(
    `UPDATE public.store_payment_integrations SET connection_status=$1, last_tested_at=now() WHERE id=$2`,
    [status, integration.id],
  );

  return json(res, { ok, message, status }, 200);
}
