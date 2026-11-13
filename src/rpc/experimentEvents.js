// Public funnel events for A/B results (view → add to cart → checkout → phone captured).
// Only a valid signed assignment for a running experiment counts; one row per visitor/event/day.
import { publicStore } from '../lib/commerce.js';
import { config } from '../config.js';
import { isBot } from '../lib/visitInfo.js';
import { verifyAssignment } from '../lib/experiments.js';
import { rateLimited } from './experiments.js';

export const EVENTS = ['view', 'add_to_cart', 'checkout_started', 'phone_captured'];

export default {
  /** track_experiment_event(p_store_id, p_visitor_id, p_ab_token, p_event) → { recorded } */
  async track_experiment_event({ p_store_id, p_visitor_id, p_ab_token, p_event }, ctx) {
    await publicStore(ctx, p_store_id);
    if (!EVENTS.includes(p_event)) return { recorded: false };
    if (isBot(String(ctx.requestHeaders?.['user-agent'] || '')) || rateLimited(ctx.requestIp)) return { recorded: false };
    const a = verifyAssignment(config.jwtSecret, p_ab_token);
    if (!a || a.visitorId !== p_visitor_id) return { recorded: false };
    const rows = await ctx.q(`INSERT INTO public.store_experiment_events (experiment_id, variant_key, visitor_id, day, event)
        SELECT e.id, $3, $4, (now() AT TIME ZONE 'Africa/Tunis')::date, $5 FROM public.store_experiments e
         WHERE e.id=$1 AND e.store_id=$2 AND e.status='running'
           AND EXISTS (SELECT 1 FROM public.store_experiment_variants v WHERE v.experiment_id=e.id AND v.key=$3)
        ON CONFLICT DO NOTHING RETURNING experiment_id`, [a.experimentId, p_store_id, a.key, a.visitorId, p_event]);
    return { recorded: rows.length > 0 };
  },
};
