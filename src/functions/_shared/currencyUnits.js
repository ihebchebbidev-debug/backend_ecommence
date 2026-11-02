// Minor units per ISO currency (Stripe/Konnect amounts are sent in the smallest unit).
const THREE = new Set(['TND', 'BHD', 'JOD', 'KWD', 'OMR', 'IQD', 'LYD']);
const ZERO = new Set(['JPY', 'KRW', 'XOF', 'XAF', 'CLP', 'VND', 'UGX', 'RWF', 'GNF', 'KMF', 'DJF', 'PYG', 'VUV', 'XPF', 'BIF', 'MGA']);
export function minorUnit(currency) {
  const c = String(currency || '').toUpperCase();
  return THREE.has(c) ? 1000 : ZERO.has(c) ? 1 : 100;
}
export function sameCurrency(a, b) {
  return !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase();
}
