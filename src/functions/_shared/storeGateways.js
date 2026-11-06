// Seller payment gateway endpoints, per the providers' public docs.
// Credentials carry mode: 'test' | 'live' (legacy 'sandbox' = test, 'production' = live).

/** Normalizes a mode value; returns null when it is not a recognised mode. */
export function normalizeMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '' ) return 'live';
  if (v === 'test' || v === 'sandbox') return 'test';
  if (v === 'live' || v === 'production' || v === 'prod') return 'live';
  return null;
}
const isSandbox = (creds) => normalizeMode(creds?.mode ?? creds?.environment) === 'test';

export const konnectBase = (c) => (isSandbox(c) ? 'https://api.sandbox.konnect.network/api/v2' : 'https://api.konnect.network/api/v2');
export const paymeeBase = (c) => (isSandbox(c) ? 'https://sandbox.paymee.tn/api/v2' : 'https://app.paymee.tn/api/v2');
export const clictopayBase = (c) => (isSandbox(c) ? 'https://test.clictopay.com/payment/rest' : 'https://ipay.clictopay.com/payment/rest');
export const FLOUCI_BASE = 'https://developers.flouci.com/api/v2';

/** Flouci counts a payment as paid only when both its success flag and status agree. */
export function flouciIsPaid(d) {
  return d?.success === true && String(d?.result?.status || '').toUpperCase() === 'SUCCESS';
}

/** ClicToPay: any non-zero errorCode is a failed call, whatever orderStatus says. */
export function clictopayHasError(data) {
  return data?.errorCode !== undefined && data?.errorCode !== null && String(data.errorCode) !== '' && Number(data.errorCode) !== 0;
}

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
