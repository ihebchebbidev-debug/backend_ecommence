// Shop order limits (Protection → Limites commandes). Values come from the shop's
// store_settings rows; blank / zero / invalid means "no limit".
export const LIMIT_KEYS = ['max_orders_per_phone', 'max_orders_per_ip', 'min_order_delay_hours', 'max_pending_orders'];

export function parseLimits(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!LIMIT_KEYS.includes(r?.key)) continue;
    const n = Number(String(r.value ?? '').trim());
    if (Number.isFinite(n) && n > 0) out[r.key] = n;
  }
  return out;
}

/**
 * stats: { phone24h, ip24h, pending, hoursSinceLast } for the buyer (non-cancelled orders).
 * Returns the French refusal message, or null when the order may proceed.
 */
export function limitViolation(limits, stats) {
  const s = stats || {};
  if (limits.max_orders_per_phone && (s.phone24h ?? 0) >= limits.max_orders_per_phone)
    return 'Nombre maximum de commandes atteint pour ce numéro aujourd’hui';
  if (limits.max_orders_per_ip && (s.ip24h ?? 0) >= limits.max_orders_per_ip)
    return 'Nombre maximum de commandes atteint depuis cet appareil aujourd’hui';
  if (limits.min_order_delay_hours && s.hoursSinceLast != null && s.hoursSinceLast < limits.min_order_delay_hours)
    return `Veuillez patienter ${limits.min_order_delay_hours} h entre deux commandes`;
  if (limits.max_pending_orders && (s.pending ?? 0) >= limits.max_pending_orders)
    return 'Vous avez déjà des commandes en attente de confirmation';
  return null;
}
