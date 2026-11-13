// Database side of A/B results, shared by the results RPCs, the CSV export, the
// experiment list (probable winner) and the auto-stop worker.
import { buildResults } from './experiments.js';
import { compareValues } from './experimentStats.js';

const DELIVERED = "(o.status='delivered' OR o.delivery_status='delivered')";
const LIVE = "o.store_id=$1 AND o.experiment_id=$2 AND o.deleted_at IS NULL AND coalesce(o.status,'') <> 'abandoned'";
// One buyer = the visitor whose signed assignment priced the order, else the phone (last 8 digits).
const BUYER = "coalesce(o.experiment_visitor_id, right(regexp_replace(coalesce(o.client_phone,''),'\\D','','g'),8))";

const cleanFilter = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 150) : null);

/**
 * results for one experiment. filters { source, device } restrict visitors (exposures)
 * and orders to visitors seen with that source/device (orders without a recorded visitor are left out when filtering).
 */
export async function computeResults(db, storeId, e, { source = null, device = null, draws = 20_000, withDaily = true } = {}) {
  const src = cleanFilter(source), dev = cleanFilter(device);
  const filtered = !!(src || dev);
  const expo = `x.experiment_id=$2 AND ($3::text IS NULL OR x.utm_source=$3) AND ($4::text IS NULL OR x.device=$4)`;
  const orderScope = filtered ? `AND EXISTS (SELECT 1 FROM public.store_experiment_exposures x WHERE ${expo} AND x.visitor_id=o.experiment_visitor_id)` : 'AND $3::text IS NULL AND $4::text IS NULL';
  const args = [storeId, e.id, src, dev];
  const exp = await db.q(`SELECT x.variant_key AS key, count(*)::int AS visitors FROM public.store_experiment_exposures x WHERE $1::uuid IS NOT NULL AND ${expo} GROUP BY 1`, args);
  const ord = await db.q(`SELECT o.experiment_variant AS key, count(*)::int AS orders,
      count(DISTINCT ${BUYER})::int AS ordering,
      count(*) FILTER (WHERE o.confirmed_at IS NOT NULL OR o.status IN ('confirmed','shipped','transit','in_transit','delivered','returned'))::int AS confirmed,
      count(*) FILTER (WHERE o.status IN ('rejected','cancelled','canceled','wrong_number'))::int AS rejected,
      count(*) FILTER (WHERE ${DELIVERED})::int AS delivered,
      count(*) FILTER (WHERE o.status='returned')::int AS returned,
      coalesce(sum(o.amount),0)::float8 AS revenue_all,
      coalesce(sum(o.amount) FILTER (WHERE ${DELIVERED}),0)::float8 AS revenue_delivered
    FROM public.orders o WHERE ${LIVE} ${orderScope} GROUP BY 1`, args);
  // Delivered money per buying visitor (revenue, and profit = amount − cost × qty − product delivery cost).
  const money = await db.q(`SELECT o.experiment_variant AS key, ${BUYER} AS buyer, sum(o.amount)::float8 AS revenue,
      sum(o.amount - coalesce(p.cost,0) * greatest(coalesce(o.quantity,1),1) - coalesce(p.delivery_cost,0))::float8 AS profit
    FROM public.orders o LEFT JOIN public.products p ON p.id=o.product_id
    WHERE ${LIVE} ${orderScope} AND ${DELIVERED} GROUP BY 1,2`, args);
  const funnel = await db.q(`SELECT ev.variant_key AS key, ev.event, count(DISTINCT ev.visitor_id)::int AS n FROM public.store_experiment_events ev
    WHERE ev.experiment_id=$2 AND $1::uuid IS NOT NULL ${filtered ? `AND EXISTS (SELECT 1 FROM public.store_experiment_exposures x WHERE ${expo} AND x.visitor_id=ev.visitor_id)` : 'AND $3::text IS NULL AND $4::text IS NULL'} GROUP BY 1,2`, args);
  const counts = {};
  const at = (k) => (counts[k] ||= { delivered_values: [], profit_values: [], profit: 0 });
  for (const r of exp) at(r.key).visitors = r.visitors;
  for (const r of ord) Object.assign(at(r.key), r);
  for (const r of money) { const c = at(r.key); c.delivered_values.push(r.revenue); c.profit_values.push(r.profit); c.profit += r.profit; }
  for (const r of funnel) at(r.key)[r.event] = r.n;
  let daily = [];
  if (withDaily) {
    daily = await db.q(`SELECT day::text, key, sum(visitors)::int AS visitors, sum(orders)::int AS orders FROM (
        SELECT (x.first_seen_at AT TIME ZONE 'Africa/Tunis')::date AS day, x.variant_key AS key, count(*) AS visitors, 0 AS orders FROM public.store_experiment_exposures x WHERE $1::uuid IS NOT NULL AND ${expo} GROUP BY 1,2
        UNION ALL
        SELECT (o.created_at AT TIME ZONE 'Africa/Tunis')::date, o.experiment_variant, 0, count(*) FROM public.orders o WHERE ${LIVE} ${orderScope} GROUP BY 1,2) d
      GROUP BY 1,2 ORDER BY 1,2`, args);
  }
  const span = await db.one(`SELECT CASE WHEN $1::timestamptz IS NULL THEN 0 ELSE
      ((coalesce($2::timestamptz, now()) AT TIME ZONE 'Africa/Tunis')::date - ($1::timestamptz AT TIME ZONE 'Africa/Tunis')::date + 1) END::int AS days`, [e.started_at, e.ended_at]);
  const out = buildResults({ experiment: e, variants: e.variants, counts, daily, days: span?.days ?? 0, compareMoney: compareValues, draws });
  return { ...out, filters: { source: src, device: dev, orders_need_visitor: filtered } };
}

/** Sources and devices seen on this experiment, for the filter menus. */
export async function filterOptions(db, experimentId) {
  const rows = await db.q(`SELECT 'source' AS kind, utm_source AS value, count(*)::int AS n FROM public.store_experiment_exposures WHERE experiment_id=$1 AND utm_source IS NOT NULL GROUP BY 2
    UNION ALL SELECT 'device', device, count(*)::int FROM public.store_experiment_exposures WHERE experiment_id=$1 AND device IS NOT NULL GROUP BY 2
    ORDER BY 3 DESC LIMIT 60`, [experimentId]);
  return { sources: rows.filter((r) => r.kind === 'source').slice(0, 30).map((r) => r.value), devices: rows.filter((r) => r.kind === 'device').map((r) => r.value) };
}
