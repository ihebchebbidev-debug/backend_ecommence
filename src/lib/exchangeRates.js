// Daily USD exchange rates for plan billing (USD quotas, TND estimates, shop-currency order values).
// Stored as source='auto' rows in currency_rates; an active admin 'manual' row always wins (see plan_usd_rate).
const CURRENCIES = ['TND', 'EUR', 'MAD', 'DZD', 'EGP', 'SAR', 'AED', 'GBP', 'CAD', 'XOF', 'LYD', 'QAR', 'KWD'];
// Sanity bounds so a broken feed can never relabel money (units of currency per 1 USD).
const BOUNDS = { TND: [2, 5], EUR: [0.6, 1.4], GBP: [0.5, 1.2] };
const SOURCE_URL = process.env.EXCHANGE_RATE_URL || 'https://open.er-api.com/v6/latest/USD';

export function pickRates(payload) {
  const rates = payload?.rates || {};
  const out = {};
  for (const c of CURRENCIES) {
    const r = Number(rates[c]);
    if (!Number.isFinite(r) || r <= 0) continue;
    const b = BOUNDS[c];
    if (b && (r < b[0] || r > b[1])) continue;
    out[c] = r;
  }
  return out;
}

export async function refreshRates(q, log, fetchImpl = fetch) {
  const res = await fetchImpl(SOURCE_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`rate feed HTTP ${res.status}`);
  const rates = pickRates(await res.json());
  if (!rates.TND) throw new Error('rate feed returned no valid TND rate');
  for (const [c, r] of Object.entries(rates)) {
    const upd = await q(`UPDATE public.currency_rates SET rate=$2, is_active=true, updated_at=now()
      WHERE base_currency='USD' AND target_currency=$1 AND source='auto' RETURNING id`, [c, r]);
    if (!upd.length) await q(`INSERT INTO public.currency_rates (base_currency, target_currency, rate, is_active, source) VALUES ('USD',$1,$2,true,'auto')`, [c, r]);
  }
  log?.info?.('exchange rates refreshed', { count: Object.keys(rates).length, tnd: rates.TND });
  return rates;
}

/** Refresh at start, then every 6 h if the last automatic update is older than a day (retries on failure). */
export function startExchangeRateWorker(q, log, everyMs = 6 * 3600 * 1000) {
  const tick = async () => {
    try {
      const last = await q(`SELECT max(updated_at) AS at FROM public.currency_rates WHERE source='auto' AND target_currency='TND'`);
      if (last[0]?.at && Date.now() - new Date(last[0].at).getTime() < 23 * 3600 * 1000) return;
      await refreshRates(q, log);
    } catch (e) { log?.warn?.('exchange rate refresh failed', { message: e.message }); }
  };
  void tick();
  const t = setInterval(tick, everyMs); t.unref?.();
  return () => clearInterval(t);
}
