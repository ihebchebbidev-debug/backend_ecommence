/** Customer identity is canonical E.164 digits; local Tunisian numbers gain 216. */
export function phoneKey(raw) {
  if (typeof raw !== 'string' || raw.length > 32 || !/^[\d\s()+.-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 8) digits = `216${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
export function tierFor(lifetime, settings) {
  if (Number(lifetime) >= Number(settings?.gold_points ?? 1500)) return 'gold';
  if (Number(lifetime) >= Number(settings?.silver_points ?? 500)) return 'silver';
  return 'bronze';
}
