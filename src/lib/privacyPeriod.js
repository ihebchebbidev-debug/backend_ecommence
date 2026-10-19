// Validates a seller-chosen deletion period (calendar days, inclusive).
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PERIOD_DAYS = 366;

export function validatePeriod(from, to, today) {
  if (!ISO.test(String(from || '')) || !ISO.test(String(to || ''))) return 'Période invalide';
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Période invalide';
  if (a > b) return 'La date de début doit précéder la date de fin';
  if (today && to > today) return 'La période ne peut pas être dans le futur';
  if ((b - a) / 86400000 + 1 > MAX_PERIOD_DAYS) return `La période ne peut pas dépasser ${MAX_PERIOD_DAYS} jours`;
  return null;
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
