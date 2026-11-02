-- Plans: Essentiel / Expansion / Performance / Prestige (billing only; features identical).
-- Every recorded order is counted once into store_plan_usage by trigger, whatever path created it.
-- Unpaid overage commissions hide that order's customer data until paid, cancelled or settled.

CREATE TABLE IF NOT EXISTS public.store_plan_state (
  store_id            uuid PRIMARY KEY,
  plan_code           text NOT NULL DEFAULT 'essentiel',
  billing_cycle       text NOT NULL DEFAULT 'monthly',
  cycle_anchor        timestamptz NOT NULL DEFAULT now(),
  period_end          timestamptz,
  pending_plan_code   text,
  allowance_eligible  boolean NOT NULL DEFAULT false,
  allowance_used_tnd  numeric NOT NULL DEFAULT 0,
  settled_cycle_start timestamptz,
  cycle_carry_usd     numeric NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.store_plan_usage (
  order_id          uuid PRIMARY KEY,
  store_id          uuid NOT NULL,
  plan_code         text NOT NULL,
  cycle_start       timestamptz,
  value_usd         numeric NOT NULL,
  value_tnd         numeric NOT NULL,
  rate              numeric NOT NULL,
  allowance_tnd     numeric NOT NULL DEFAULT 0,
  overage_usd       numeric NOT NULL DEFAULT 0,
  commission_usd    numeric NOT NULL DEFAULT 0,
  commission_status text NOT NULL DEFAULT 'none',
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);
CREATE INDEX IF NOT EXISTS store_plan_usage_store_idx ON public.store_plan_usage (store_id, created_at);
CREATE INDEX IF NOT EXISTS store_plan_usage_unpaid_idx ON public.store_plan_usage (store_id, created_at) WHERE commission_status = 'unpaid';

CREATE TABLE IF NOT EXISTS public.store_plan_events (
  id         bigserial PRIMARY KEY,
  store_id   uuid NOT NULL,
  kind       text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_plan_events_store_idx ON public.store_plan_events (store_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.plan_quota_usd(p_code text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_code WHEN 'expansion' THEN 150000::numeric WHEN 'performance' THEN 350000::numeric ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.plan_rank(p_code text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_code WHEN 'essentiel' THEN 0 WHEN 'expansion' THEN 1 WHEN 'performance' THEN 2 WHEN 'prestige' THEN 3 ELSE -1 END
$$;

-- Quota cycle start keeping the anniversary day (Postgres month arithmetic clamps 29/30/31 to short months).
CREATE OR REPLACE FUNCTION public.plan_cycle_start(p_anchor timestamptz, p_at timestamptz) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n int; c timestamptz;
BEGIN
  n := (extract(year FROM p_at)::int - extract(year FROM p_anchor)::int) * 12 + extract(month FROM p_at)::int - extract(month FROM p_anchor)::int;
  IF n < 0 THEN RETURN p_anchor; END IF;
  c := p_anchor + make_interval(months => n);
  IF c > p_at THEN c := p_anchor + make_interval(months => greatest(n - 1, 0)); END IF;
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION public.plan_usd_rate(p_currency text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN upper(coalesce(p_currency,'USD')) = 'USD' THEN 1::numeric ELSE coalesce(
    (SELECT rate FROM public.currency_rates WHERE is_active AND base_currency = 'USD' AND target_currency = upper(p_currency) AND rate > 0 ORDER BY (source = 'manual') DESC, updated_at DESC LIMIT 1),
    CASE WHEN upper(p_currency) = 'TND' THEN 3.1::numeric ELSE 1::numeric END) END
$$;

-- Ensure the state row; the TND 15,000 allowance goes only to the first shop of an owner email/phone.
CREATE OR REPLACE FUNCTION public.plan_ensure_state(p_store uuid) RETURNS public.store_plan_state LANGUAGE plpgsql AS $$
DECLARE st public.store_plan_state; owner uuid; em text; ph text; eligible boolean;
BEGIN
  SELECT * INTO st FROM public.store_plan_state WHERE store_id = p_store FOR UPDATE;
  IF FOUND THEN RETURN st; END IF;
  SELECT s.user_id, lower(nullif(trim(p.email),'')), nullif(regexp_replace(coalesce(p.phone,''),'\D','','g'),'')
    INTO owner, em, ph FROM public.platform_stores s LEFT JOIN public.profiles p ON p.id = s.user_id WHERE s.id = p_store;
  eligible := NOT EXISTS (
    SELECT 1 FROM public.store_plan_state o JOIN public.platform_stores s2 ON s2.id = o.store_id
      LEFT JOIN public.profiles p2 ON p2.id = s2.user_id
     WHERE o.allowance_eligible AND o.store_id <> p_store AND (
       (owner IS NOT NULL AND s2.user_id = owner)
       OR (em IS NOT NULL AND lower(trim(p2.email)) = em)
       OR (ph IS NOT NULL AND regexp_replace(coalesce(p2.phone,''),'\D','','g') = ph)));
  INSERT INTO public.store_plan_state (store_id, allowance_eligible) VALUES (p_store, eligible)
    ON CONFLICT (store_id) DO NOTHING;
  SELECT * INTO st FROM public.store_plan_state WHERE store_id = p_store FOR UPDATE;
  RETURN st;
END $$;

-- Settle unpaid overage with available quota: oldest first, whole orders only. Returns settled overage value.
CREATE OR REPLACE FUNCTION public.plan_settle(p_store uuid, p_available numeric, p_cycle timestamptz) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE r record; left_q numeric := greatest(coalesce(p_available,0),0); carry numeric := 0;
BEGIN
  FOR r IN SELECT order_id, overage_usd, cycle_start FROM public.store_plan_usage
            WHERE store_id = p_store AND commission_status = 'unpaid' ORDER BY created_at, order_id LOOP
    EXIT WHEN r.overage_usd > left_q;
    left_q := left_q - r.overage_usd;
    UPDATE public.store_plan_usage SET commission_status = 'settled', resolved_at = now() WHERE order_id = r.order_id;
    IF r.cycle_start IS DISTINCT FROM p_cycle THEN carry := carry + r.overage_usd; END IF;
  END LOOP;
  RETURN carry;
END $$;

-- Quota still free in the current cycle, ignoring the unpaid overage parts already beyond it.
CREATE OR REPLACE FUNCTION public.plan_cycle_free(p_store uuid, p_quota numeric, p_cycle timestamptz, p_carry numeric) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT greatest(p_quota - coalesce(sum(value_usd - CASE WHEN commission_status = 'unpaid' THEN overage_usd ELSE 0 END), 0) - p_carry, 0)
    FROM public.store_plan_usage WHERE store_id = p_store AND cycle_start = p_cycle
$$;

-- Apply scheduled downgrades/expiry and start a new quota cycle (settling previous unpaid overage first).
CREATE OR REPLACE FUNCTION public.plan_refresh(p_store uuid) RETURNS public.store_plan_state LANGUAGE plpgsql AS $$
DECLARE st public.store_plan_state; cur timestamptz; q numeric;
BEGIN
  st := public.plan_ensure_state(p_store);
  IF st.period_end IS NOT NULL AND now() >= st.period_end THEN
    INSERT INTO public.store_plan_events (store_id, kind, details) VALUES (p_store, CASE WHEN st.pending_plan_code IS NULL THEN 'expired' ELSE 'downgraded' END,
      jsonb_build_object('from', st.plan_code, 'to', coalesce(st.pending_plan_code, 'essentiel')));
    UPDATE public.store_plan_state SET plan_code = coalesce(pending_plan_code, 'essentiel'), pending_plan_code = NULL,
      period_end = NULL, cycle_anchor = now(), settled_cycle_start = NULL, cycle_carry_usd = 0, updated_at = now() WHERE store_id = p_store
      RETURNING * INTO st;
  END IF;
  q := public.plan_quota_usd(st.plan_code);
  IF q IS NOT NULL THEN
    cur := public.plan_cycle_start(st.cycle_anchor, now());
    IF st.settled_cycle_start IS DISTINCT FROM cur THEN
      UPDATE public.store_plan_state SET settled_cycle_start = cur, cycle_carry_usd = public.plan_settle(p_store, q, cur), updated_at = now()
       WHERE store_id = p_store RETURNING * INTO st;
    END IF;
  END IF;
  RETURN st;
END $$;

-- Count one order exactly once at its final amount; abandoned captures are never counted.
CREATE OR REPLACE FUNCTION public.plan_record_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st public.store_plan_state; rate numeric; tnd_rate numeric; v_usd numeric; v_tnd numeric; q numeric; cur timestamptz;
  free_q numeric; covered numeric := 0; over numeric := 0;
BEGIN
  IF NEW.store_id IS NULL OR coalesce(NEW.status,'') = 'abandoned' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND coalesce(OLD.status,'') <> 'abandoned' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.store_plan_usage WHERE order_id = NEW.id) THEN RETURN NEW; END IF;
  st := public.plan_refresh(NEW.store_id);
  rate := public.plan_usd_rate(NEW.currency);
  tnd_rate := public.plan_usd_rate('TND');
  v_usd := round(greatest(coalesce(NEW.amount,0),0) / rate, 2);
  v_tnd := round(v_usd * tnd_rate, 3);
  q := public.plan_quota_usd(st.plan_code);
  IF st.plan_code = 'prestige' THEN
    over := 0;
  ELSIF q IS NOT NULL THEN
    cur := public.plan_cycle_start(st.cycle_anchor, now());
    free_q := public.plan_cycle_free(NEW.store_id, q, cur, st.cycle_carry_usd);
    over := greatest(v_usd - free_q, 0);
  ELSE
    IF st.allowance_eligible THEN covered := least(v_tnd, greatest(15000 - st.allowance_used_tnd, 0)); END IF;
    over := round((v_tnd - covered) / tnd_rate, 2);
    UPDATE public.store_plan_state SET allowance_used_tnd = allowance_used_tnd + covered, updated_at = now() WHERE store_id = NEW.store_id;
  END IF;
  INSERT INTO public.store_plan_usage (order_id, store_id, plan_code, cycle_start, value_usd, value_tnd, rate, allowance_tnd, overage_usd, commission_usd, commission_status)
  VALUES (NEW.id, NEW.store_id, st.plan_code, cur, v_usd, v_tnd, tnd_rate, covered, over, round(over * 0.003, 2),
          CASE WHEN round(over * 0.003, 2) > 0 THEN 'unpaid' ELSE 'none' END)
  ON CONFLICT (order_id) DO NOTHING;
  PERFORM public.plan_quota_alerts(NEW.store_id);
  RETURN NEW;
END $$;

-- 80% / 100% alerts, once per quota cycle (or once for the one-time Essentiel allowance).
CREATE OR REPLACE FUNCTION public.plan_quota_alerts(p_store uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE st public.store_plan_state; q numeric; cur timestamptz; used numeric; pct numeric; lvl int; scope text;
BEGIN
  IF to_regclass('public.commerce_notifications') IS NULL THEN RETURN; END IF;
  SELECT * INTO st FROM public.store_plan_state WHERE store_id = p_store;
  IF NOT FOUND OR st.plan_code = 'prestige' THEN RETURN; END IF;
  q := public.plan_quota_usd(st.plan_code);
  IF q IS NOT NULL THEN
    cur := public.plan_cycle_start(st.cycle_anchor, now());
    SELECT coalesce(sum(value_usd),0) + st.cycle_carry_usd INTO used FROM public.store_plan_usage WHERE store_id = p_store AND cycle_start = cur;
    pct := used / q * 100; scope := st.plan_code || ':' || to_char(cur AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS');
  ELSIF st.allowance_eligible THEN
    pct := st.allowance_used_tnd / 15000 * 100; scope := 'allowance';
  ELSE RETURN; END IF;
  FOREACH lvl IN ARRAY ARRAY[80, 100] LOOP
    IF pct >= lvl THEN
      INSERT INTO public.commerce_notifications(store_id, type, source_id, event_key, data)
      VALUES (p_store, 'plan_quota', p_store, 'plan_quota:' || p_store || ':' || scope || ':' || lvl,
              jsonb_build_object('level', lvl, 'plan_code', st.plan_code, 'allowance', q IS NULL))
      ON CONFLICT (event_key) DO NOTHING;
    END IF;
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS orders_plan_usage ON public.orders;
CREATE TRIGGER orders_plan_usage AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.plan_record_order();

-- One-click plan change (no payment yet). Upgrades apply now; downgrades wait for a paid period end.
CREATE OR REPLACE FUNCTION public.plan_switch(p_store uuid, p_code text, p_cycle text) RETURNS public.store_plan_state LANGUAGE plpgsql AS $$
DECLARE st public.store_plan_state; q numeric; cur timestamptz; from_code text;
BEGIN
  IF public.plan_rank(p_code) < 0 THEN RAISE EXCEPTION 'invalid plan %', p_code; END IF;
  IF p_code = 'essentiel' THEN p_cycle := 'monthly'; END IF;
  IF p_cycle NOT IN ('monthly','annual') THEN RAISE EXCEPTION 'invalid cycle %', p_cycle; END IF;
  st := public.plan_refresh(p_store);
  from_code := st.plan_code;
  IF from_code = p_code AND st.billing_cycle = p_cycle THEN RETURN st; END IF;
  IF public.plan_rank(p_code) < public.plan_rank(from_code) AND st.period_end IS NOT NULL AND now() < st.period_end THEN
    UPDATE public.store_plan_state SET pending_plan_code = p_code, updated_at = now() WHERE store_id = p_store RETURNING * INTO st;
    INSERT INTO public.store_plan_events (store_id, kind, details) VALUES (p_store, 'downgrade_scheduled', jsonb_build_object('from', from_code, 'to', p_code, 'at', st.period_end));
    RETURN st;
  END IF;
  -- Moving from no quota to a quota plan starts a fresh anniversary; Expansion <-> Performance keeps it.
  UPDATE public.store_plan_state SET plan_code = p_code, billing_cycle = p_cycle, pending_plan_code = NULL,
    cycle_anchor = CASE WHEN public.plan_quota_usd(from_code) IS NULL THEN now() ELSE cycle_anchor END,
    settled_cycle_start = CASE WHEN public.plan_quota_usd(from_code) IS NULL THEN NULL ELSE settled_cycle_start END,
    cycle_carry_usd = CASE WHEN public.plan_quota_usd(from_code) IS NULL THEN 0 ELSE cycle_carry_usd END,
    updated_at = now() WHERE store_id = p_store RETURNING * INTO st;
  IF p_code = 'prestige' THEN
    UPDATE public.store_plan_usage SET commission_status = 'cancelled', resolved_at = now() WHERE store_id = p_store AND commission_status = 'unpaid';
  ELSE
    q := public.plan_quota_usd(p_code);
    IF q IS NOT NULL THEN
      cur := public.plan_cycle_start(st.cycle_anchor, now());
      UPDATE public.store_plan_state SET settled_cycle_start = cur,
        cycle_carry_usd = cycle_carry_usd + public.plan_settle(p_store, public.plan_cycle_free(p_store, q, cur, st.cycle_carry_usd), cur)
       WHERE store_id = p_store RETURNING * INTO st;
    END IF;
  END IF;
  INSERT INTO public.store_plan_events (store_id, kind, details) VALUES (p_store, 'plan_changed', jsonb_build_object('from', from_code, 'to', p_code, 'cycle', p_cycle));
  RETURN st;
END $$;

-- Billing dashboard numbers for one shop.
CREATE OR REPLACE FUNCTION public.plan_overview(p_store uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE st public.store_plan_state; q numeric; cur timestamptz; used numeric := 0;
BEGIN
  st := public.plan_refresh(p_store);
  q := public.plan_quota_usd(st.plan_code);
  IF q IS NOT NULL THEN
    cur := public.plan_cycle_start(st.cycle_anchor, now());
    SELECT coalesce(sum(value_usd),0) + st.cycle_carry_usd INTO used FROM public.store_plan_usage WHERE store_id = p_store AND cycle_start = cur;
  END IF;
  RETURN jsonb_build_object(
    'plan_code', st.plan_code, 'billing_cycle', st.billing_cycle, 'pending_plan_code', st.pending_plan_code,
    'period_end', st.period_end, 'cycle_start', cur, 'cycle_end', CASE WHEN cur IS NULL THEN NULL ELSE st.cycle_anchor + make_interval(months => (extract(year FROM cur)::int - extract(year FROM st.cycle_anchor)::int) * 12 + extract(month FROM cur)::int - extract(month FROM st.cycle_anchor)::int + 1) END,
    'quota_usd', q, 'used_usd', used, 'carry_usd', st.cycle_carry_usd,
    'remaining_usd', CASE WHEN q IS NULL THEN NULL ELSE greatest(q - used, 0) END,
    'usage_pct', CASE WHEN q IS NULL THEN NULL ELSE round(least(used / q, 9.99) * 100, 1) END,
    'allowance_eligible', st.allowance_eligible, 'allowance_used_tnd', st.allowance_used_tnd,
    'allowance_left_tnd', CASE WHEN st.allowance_eligible THEN greatest(15000 - st.allowance_used_tnd, 0) ELSE 0 END,
    'usd_tnd_rate', public.plan_usd_rate('TND'),
    'unpaid_commission_usd', (SELECT coalesce(sum(commission_usd),0) FROM public.store_plan_usage WHERE store_id = p_store AND commission_status = 'unpaid'),
    'unpaid_overage_usd', (SELECT coalesce(sum(overage_usd),0) FROM public.store_plan_usage WHERE store_id = p_store AND commission_status = 'unpaid'),
    'paid_commission_usd', (SELECT coalesce(sum(commission_usd),0) FROM public.store_plan_usage WHERE store_id = p_store AND commission_status = 'paid'),
    'hidden_orders', (SELECT count(*) FROM public.store_plan_usage WHERE store_id = p_store AND commission_status = 'unpaid'),
    'events', (SELECT coalesce(jsonb_agg(e ORDER BY e.created_at DESC), '[]'::jsonb) FROM (SELECT kind, details, created_at FROM public.store_plan_events WHERE store_id = p_store ORDER BY created_at DESC LIMIT 20) e));
END $$;
