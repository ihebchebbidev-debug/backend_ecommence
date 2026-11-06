// Platform (plan billing) Konnect settings: one source for create, callback and test,
// so the same key, wallet and test/live mode are used at every step.
import { normalizeMode } from './storeGateways.js';

export const PLATFORM_GATEWAY_SETTINGS_ID = '00000000-0000-0000-0000-000000000002';
export const PLATFORM_SUPPORTED_PROVIDERS = ['konnect'];

export async function readPlatformKonnect(ctx) {
  const s = await ctx.q(
    'SELECT provider, api_key, wallet_id, environment FROM public.payment_gateway_settings WHERE id=$1',
    [PLATFORM_GATEWAY_SETTINGS_ID],
  ).then((r) => r[0]).catch(() => null);
  const apiKey = s?.api_key || process.env.KONNECT_API_KEY || '';
  const walletId = s?.wallet_id || process.env.KONNECT_WALLET_ID || '';
  const mode = normalizeMode(s?.environment ?? process.env.KONNECT_MODE ?? '') || 'live';
  const base = mode === 'test' ? 'https://api.sandbox.konnect.network/api/v2' : 'https://api.konnect.network/api/v2';
  return { provider: s?.provider || 'konnect', apiKey, walletId, mode, base };
}
