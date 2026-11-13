// Money-per-visitor statistics for A/B results (delivered revenue or profit per visitor).
// Pure and seeded so verdicts stay stable between refreshes.
import { betaSample, rng } from './experiments.js';

function normal(rand) { let u = 0; while (u === 0) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); }
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : null);

/** One simulated value per visitor: P(buy) ~ Beta posterior × bootstrapped mean order value. */
function drawPerVisitor(arm, rand) {
  const n = arm.visitors, values = arm.values;
  const k = Math.min(values.length, n);
  const p = betaSample(1 + k, 1 + Math.max(0, n - k), rand);
  if (!k) return 0;
  let mean;
  if (k > 400) {
    // Large samples: the bootstrap mean is normal around the sample mean.
    const m = values.reduce((s, v) => s + v, 0) / k;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, k - 1));
    mean = m + normal(rand) * sd / Math.sqrt(k);
  } else {
    let sum = 0;
    for (let i = 0; i < k; i += 1) sum += values[Math.floor(rand() * k)];
    mean = sum / k;
  }
  return p * mean;
}

/**
 * arms: [{ key, visitors, values: [value per buying visitor] }] (non-buyers count as 0).
 * Returns per key: perVisitor, probBest, probBeatControl, lift, liftLow, liftHigh.
 */
export function compareValues(arms, controlKey, { draws = 4000, seed = 1 } = {}) {
  const rand = rng(seed);
  const ctrl = arms.findIndex((a) => a.key === controlKey);
  const best = arms.map(() => 0), beat = arms.map(() => 0), lifts = arms.map(() => []);
  for (let i = 0; i < draws; i += 1) {
    const s = arms.map((a) => drawPerVisitor(a, rand));
    let top = 0; for (let j = 1; j < s.length; j += 1) if (s[j] > s[top]) top = j;
    best[top] += 1;
    s.forEach((x, j) => { if (j === ctrl) return; if (x > s[ctrl]) beat[j] += 1; lifts[j].push(s[ctrl] !== 0 ? x / Math.abs(s[ctrl]) - Math.sign(s[ctrl]) : 0); });
  }
  return Object.fromEntries(arms.map((a, j) => {
    const l = lifts[j].sort((x, y) => x - y);
    const total = a.values.reduce((s, v) => s + v, 0);
    return [a.key, {
      perVisitor: a.visitors > 0 ? total / a.visitors : null,
      probBest: best[j] / draws,
      probBeatControl: j === ctrl ? null : beat[j] / draws,
      lift: j === ctrl ? null : quantile(l, 0.5),
      liftLow: j === ctrl ? null : quantile(l, 0.025),
      liftHigh: j === ctrl ? null : quantile(l, 0.975),
    }];
  }));
}

/**
 * Profit of one delivered order for the tested product:
 * amount paid − product cost × quantity − the product's delivery cost (current product values; no snapshot exists).
 */
export function orderProfit(order, product) {
  const qty = Math.max(1, Number(order.quantity) || 1);
  return Number(order.amount || 0) - Number(product?.cost || 0) * qty - Number(product?.delivery_cost || 0);
}

/** Funnel steps in display order. */
export const FUNNEL = ['view', 'add_to_cart', 'checkout_started', 'phone_captured', 'orders', 'confirmed', 'delivered'];

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV text of the per-variant table followed by the daily rows. */
export function resultsCsv(results) {
  const pct = (v) => (v == null ? '' : (Math.round(v * 10000) / 100).toString());
  const head = ['variant', 'name', 'traffic_pct', 'visitors', 'orders', 'conversion_pct', 'confirmation_pct', 'delivery_pct', 'revenue_all', 'revenue_delivered', 'profit', 'aov_all', 'prob_best_pct', 'prob_beat_control_pct', 'lift_pct', 'lift_low_pct', 'lift_high_pct'];
  const rows = results.variants.map((v) => [v.key, v.name, v.traffic_pct, v.visitors, v.orders, pct(v.conversion_rate), pct(v.confirmation_rate), pct(v.delivery_rate),
    v.revenue_all, v.revenue_delivered, v.profit, v.aov_all == null ? '' : Math.round(v.aov_all * 1000) / 1000, pct(v.probBest), pct(v.probBeatControl), pct(v.lift), pct(v.liftLow), pct(v.liftHigh)]);
  const daily = [['day', 'variant', 'visitors', 'orders'], ...(results.daily || []).map((d) => [d.day, d.key, d.visitors, d.orders])];
  return [head, ...rows, [], ...daily].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
