// Checkout side of A/B testing: a variant price exists only when the server
// re-checks the signed assignment token against a running experiment.
import { config } from '../config.js';
import { verifyAssignment } from './experiments.js';

/** { experimentId, key, visitorId, targetType, overrides } for a valid token on this shop/product, else null (original price). */
export async function variantForToken(db, storeId, productId, token) {
  if (!token) return null;
  const a = verifyAssignment(config.jwtSecret, token);
  if (!a) return null;
  // Product tests change the price; page and order-form tests only attribute the order.
  const row = await db.one(`SELECT v.key, v.is_control, v.overrides, e.target_type FROM public.store_experiments e
      JOIN public.store_experiment_variants v ON v.experiment_id = e.id AND v.key = $4
     WHERE e.id = $1 AND e.store_id = $2 AND e.status = 'running'
       AND ((e.target_type = 'product' AND e.product_id = $3) OR e.target_type IN ('sales_page','checkout_form'))`, [a.experimentId, storeId, productId, a.key]);
  if (!row) return null;
  const priced = row.target_type === 'product' && !row.is_control;
  return { experimentId: a.experimentId, key: row.key, visitorId: a.visitorId, targetType: row.target_type, overrides: priced ? (row.overrides || {}) : {} };
}

/** Record which variant an order (or unfinished checkout) was priced with. */
export async function recordOrderExperiment(db, orderId, quote) {
  // Product tests win over page/order-form tests when a basket carries several.
  const hit = quote?.rows?.find((r) => r.experiment?.targetType === 'product') ?? quote?.rows?.find((r) => r.experiment);
  // No token on this attempt: keep what an earlier capture recorded (a promoted order stays attributed).
  if (!hit) return;
  await db.q(`UPDATE public.orders SET experiment_id = $2, experiment_variant = $3, experiment_visitor_id = $4
     WHERE id = $1 AND (experiment_id, experiment_variant, experiment_visitor_id) IS DISTINCT FROM ($2::uuid, $3::text, $4::text)`,
    [orderId, hit.experiment.experimentId, hit.experiment.key, hit.experiment.visitorId || null]);
}
