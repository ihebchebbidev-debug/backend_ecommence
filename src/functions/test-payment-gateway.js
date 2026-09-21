// Port of supabase/functions/test-payment-gateway/index.ts
import { json } from './_shared/respond.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000002';

export default async function testPaymentGateway(req, res, ctx) {
  try {
    if (!ctx.userId) return json(res, { error: 'Unauthorized' }, 401);

    const profile = await ctx.q('SELECT status, deleted_at FROM public.profiles WHERE id=$1', [ctx.userId]).then((r) => r[0]);
    if (profile?.deleted_at || (profile?.status && profile.status !== 'active')) {
      return json(res, { error: 'Account suspended or deleted' }, 403);
    }

    const isSuperAdmin = await ctx.isSuperAdmin();
    if (!isSuperAdmin) return json(res, { error: 'Super admin only' }, 403);

    const settings = await ctx.q(
      'SELECT provider, api_key, wallet_id, environment FROM public.payment_gateway_settings WHERE id=$1',
      [SETTINGS_ID],
    ).then((r) => r[0]);

    const provider = settings?.provider || 'konnect';
    const apiKey = settings?.api_key || process.env.KONNECT_API_KEY || '';
    const walletId = settings?.wallet_id || process.env.KONNECT_WALLET_ID || '';

    let ok = false;
    let message = '';

    if (provider === 'konnect') {
      if (!apiKey) {
        message = 'Clé API Konnect manquante';
      } else {
        try {
          const r = await fetch('https://api.konnect.network/api/v2/wallets', {
            method: 'GET',
            headers: { 'x-api-key': apiKey },
          });
          ok = r.ok;
          if (r.ok) {
            message = walletId ? 'Connexion Konnect réussie' : 'Connexion OK (wallet_id non défini)';
          } else {
            const txt = await r.text().catch(() => '');
            message = `Konnect HTTP ${r.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`;
          }
        } catch (e) {
          message = `Erreur réseau: ${e?.message || 'unknown'}`;
        }
      }
    } else if (provider === 'paymee') {
      if (!apiKey) {
        message = 'Clé API Paymee manquante';
      } else {
        // Real call to Paymee: a rejected token answers 401/403, a valid token
        // answers 200/422 (payload validation) on the same endpoint.
        const host = settings?.environment === 'production' ? 'app.paymee.tn' : 'sandbox.paymee.tn';
        try {
          const r = await fetch(`https://${host}/api/v2/payments/create`, {
            method: 'POST',
            headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 0.1, note: 'connection test', first_name: 'test', last_name: 'test', email: 'test@example.com', phone: '00000000' }),
          });
          if (r.status === 401 || r.status === 403) {
            message = 'Clé API Paymee refusée par Paymee (401/403)';
          } else if (r.status >= 500) {
            message = `Paymee indisponible (HTTP ${r.status})`;
          } else {
            ok = true;
            message = `Connexion Paymee réussie (${host})`;
          }
        } catch (e) {
          message = `Erreur réseau Paymee: ${e?.message || 'unknown'}`;
        }
      }
    } else {
      ok = !!apiKey;
      message = ok ? 'Clé personnalisée présente' : 'Clé API manquante';
    }

    const status = ok ? 'connected' : 'error';
    await ctx.q(
      'UPDATE public.payment_gateway_settings SET connection_status=$1, last_tested_at=now() WHERE id=$2',
      [status, SETTINGS_ID],
    );

    return json(res, { ok, message, status });
  } catch (err) {
    return json(res, { ok: false, message: err?.message || 'Erreur' }, 500);
  }
}
