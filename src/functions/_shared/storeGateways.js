// Seller payment gateway endpoints, per the providers' public docs.
// Credentials may carry mode: 'sandbox' to use the provider's test environment.
const isSandbox = (creds) => String(creds?.mode || '').toLowerCase() === 'sandbox';

export const konnectBase = (c) => (isSandbox(c) ? 'https://api.sandbox.konnect.network/api/v2' : 'https://api.konnect.network/api/v2');
export const paymeeBase = (c) => (isSandbox(c) ? 'https://sandbox.paymee.tn/api/v2' : 'https://app.paymee.tn/api/v2');
export const clictopayBase = (c) => (isSandbox(c) ? 'https://test.clictopay.com/payment/rest' : 'https://ipay.clictopay.com/payment/rest');
export const FLOUCI_BASE = 'https://developers.flouci.com/api/v2';

/** ClicToPay (SMT) REST call: form-encoded POST with the merchant API login. */
export async function clictopayCall(creds, method, params) {
  const body = new URLSearchParams({ userName: creds.username || '', password: creds.password || '', ...params });
  const r = await fetch(`${clictopayBase(creds)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
