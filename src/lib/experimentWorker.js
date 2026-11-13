// Optional auto-stop: running experiments with auto_stop end when one variant has a
// ≥ 99 % chance to be best (after the usual minimum days/visitors/orders). The winner
// is never applied automatically; the seller gets an "experiment ended" alert.
import { AUTO_STOP_PROB } from './experiments.js';
import { computeResults } from './experimentResults.js';

export async function autoStopTick(db, log) {
  const running = await db.q(`SELECT * FROM public.store_experiments WHERE status='running' AND auto_stop LIMIT 500`);
  let stopped = 0;
  for (const e of running) {
    try {
      e.variants = await db.q('SELECT key, name, is_control, traffic_pct, overrides, change_keys FROM public.store_experiment_variants WHERE experiment_id=$1 ORDER BY key', [e.id]);
      const r = await computeResults(db, e.store_id, e, { withDaily: false });
      const v = r.verdict;
      if (v.state !== 'winner' || !(v.prob >= AUTO_STOP_PROB)) continue;
      const done = await db.q(`UPDATE public.store_experiments SET status='completed', ended_at=now(), paused_at=NULL, winner_key=$2, applied_winner=false, auto_stopped=true,
          winner_history=winner_history || $3::jsonb, version=version+1, updated_at=now()
        WHERE id=$1 AND status='running' AND auto_stop RETURNING id`, [e.id, v.key, JSON.stringify([{ key: v.key, applied: false, auto: true, at: new Date().toISOString() }])]);
      if (!done.length) continue;
      stopped += 1;
      await db.q(`INSERT INTO public.commerce_notifications (store_id, type, source_id, event_key, data) VALUES ($1,'experiment_ended',$2,$3,$4::jsonb) ON CONFLICT (event_key) DO NOTHING`,
        [e.store_id, e.id, `experiment_ended:${e.id}`, JSON.stringify({ name: e.name, winner_key: v.key, prob: Math.round(v.prob * 1000) / 1000 })]);
    } catch (err) { log?.warn?.('experiment auto-stop failed', { experiment: e.id, message: err.message }); }
  }
  return stopped;
}

export function startExperimentWorker(q, log, everyMs = 15 * 60_000) {
  const db = { q, one: async (sql, p) => (await q(sql, p))[0] ?? null };
  const tick = () => autoStopTick(db, log).catch((err) => log?.warn?.('experiment auto-stop tick failed', { message: err.message }));
  const t = setInterval(tick, everyMs); t.unref?.();
  setTimeout(tick, 60_000).unref?.();
  return () => clearInterval(t);
}
