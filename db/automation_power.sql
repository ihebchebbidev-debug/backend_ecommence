-- Stronger seller automations: more events, more channels, conditions and multi-step sequences.
-- Idempotent; applied after store_automations.sql.
BEGIN;
ALTER TABLE public.store_automations ADD COLUMN IF NOT EXISTS conditions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.store_automations ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.store_automations ADD COLUMN IF NOT EXISTS webhook_url text NOT NULL DEFAULT '';
ALTER TABLE public.store_automations DROP CONSTRAINT IF EXISTS store_automations_trigger_event_check;
ALTER TABLE public.store_automations ADD CONSTRAINT store_automations_trigger_event_check CHECK (trigger_event IN (
  'order_created','order_confirmed','order_shipped','order_in_transit','order_delivered','order_cancelled','order_returned',
  'order_rejected','order_attempt1','order_attempt2','payment_received','payment_failed'));
ALTER TABLE public.store_automations DROP CONSTRAINT IF EXISTS store_automations_channel_check;
ALTER TABLE public.store_automations ADD CONSTRAINT store_automations_channel_check CHECK (channel IN ('sms','email','email_customer','webhook'));

-- One run per automation, order and step (step 0 = the main message).
ALTER TABLE public.store_automation_runs ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0;
ALTER TABLE public.store_automation_runs DROP CONSTRAINT IF EXISTS store_automation_runs_automation_id_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS store_automation_runs_step_key ON public.store_automation_runs(automation_id, order_id, step_index);
CREATE INDEX IF NOT EXISTS store_automation_runs_history ON public.store_automation_runs(store_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.schedule_store_automations() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN kind := 'order_created';
  ELSIF NEW.payment_status = 'failed' AND OLD.payment_status IS DISTINCT FROM 'failed' THEN kind := 'payment_failed';
  ELSIF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN kind := 'payment_received';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    kind := CASE NEW.status WHEN 'confirmed' THEN 'order_confirmed' WHEN 'shipped' THEN 'order_shipped'
      WHEN 'transit' THEN 'order_in_transit' WHEN 'in_transit' THEN 'order_in_transit'
      WHEN 'delivered' THEN 'order_delivered' WHEN 'cancelled' THEN 'order_cancelled' WHEN 'canceled' THEN 'order_cancelled'
      WHEN 'returned' THEN 'order_returned' WHEN 'rejected' THEN 'order_rejected'
      WHEN 'attempt1' THEN 'order_attempt1' WHEN 'attempt2' THEN 'order_attempt2' END;
  ELSIF NEW.delivery_status = 'delivered' AND OLD.delivery_status IS DISTINCT FROM 'delivered' THEN kind := 'order_delivered';
  END IF;
  IF kind IS NULL THEN RETURN NEW; END IF;
  -- Step 0 waits delay_minutes; each later step waits its own delay after the previous one.
  INSERT INTO public.store_automation_runs(automation_id, store_id, order_id, step_index, send_at)
  SELECT a.id, NEW.store_id, NEW.id, s.idx,
         now() + make_interval(mins => a.delay_minutes + COALESCE((
           SELECT sum(LEAST(10080, GREATEST(0, COALESCE((e->>'delay_minutes')::int, 0))))
           FROM jsonb_array_elements(a.steps) WITH ORDINALITY AS x(e, n) WHERE x.n <= s.idx), 0)::int)
  FROM public.store_automations a
  CROSS JOIN LATERAL generate_series(0, jsonb_array_length(a.steps)) AS s(idx)
  WHERE a.store_id = NEW.store_id AND a.active AND a.trigger_event = kind
  ON CONFLICT (automation_id, order_id, step_index) DO NOTHING;
  RETURN NEW;
END; $$;
COMMIT;
