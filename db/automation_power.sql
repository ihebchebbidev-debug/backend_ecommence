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
ALTER TABLE public.store_automation_runs ADD COLUMN IF NOT EXISTS definition jsonb;
ALTER TABLE public.store_automation_runs DROP CONSTRAINT IF EXISTS store_automation_runs_automation_id_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS store_automation_runs_step_key ON public.store_automation_runs(automation_id, order_id, step_index);
CREATE INDEX IF NOT EXISTS store_automation_runs_history ON public.store_automation_runs(store_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.schedule_store_automations() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kind text; kinds text[] := ARRAY[]::text[];
BEGIN
  IF NEW.status = 'abandoned' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status = 'abandoned') THEN kind := 'order_created';
  ELSE
  IF NEW.payment_status = 'failed' AND OLD.payment_status IS DISTINCT FROM 'failed' THEN kind := 'payment_failed';
  ELSIF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN kind := 'payment_received';
  END IF;
  IF kind IS NOT NULL THEN kinds := array_append(kinds,kind); END IF;
  kind := NULL;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    kind := CASE NEW.status WHEN 'confirmed' THEN 'order_confirmed' WHEN 'shipped' THEN 'order_shipped'
      WHEN 'transit' THEN 'order_in_transit' WHEN 'in_transit' THEN 'order_in_transit'
      WHEN 'delivered' THEN 'order_delivered' WHEN 'cancelled' THEN 'order_cancelled' WHEN 'canceled' THEN 'order_cancelled'
      WHEN 'returned' THEN 'order_returned' WHEN 'rejected' THEN 'order_rejected'
      WHEN 'attempt1' THEN 'order_attempt1' WHEN 'attempt2' THEN 'order_attempt2' END;
  END IF;
  IF kind IS NOT NULL THEN kinds := array_append(kinds,kind); END IF;
  kind := NULL;
  IF NEW.delivery_status = 'delivered' AND OLD.delivery_status IS DISTINCT FROM 'delivered' THEN kind := 'order_delivered';
  END IF;
  END IF;
  IF kind IS NOT NULL THEN kinds := array_append(kinds,kind); END IF;
  IF cardinality(kinds)=0 THEN RETURN NEW; END IF;
  -- Follow-ups are released only after their predecessor succeeds.
  INSERT INTO public.store_automation_runs(automation_id, store_id, order_id, step_index, send_at, definition)
  SELECT a.id, NEW.store_id, NEW.id, s.idx,
         CASE WHEN s.idx=0 THEN now()+make_interval(mins=>a.delay_minutes) ELSE 'infinity'::timestamptz END,
         CASE WHEN s.idx=0 THEN to_jsonb(a)-'steps' ELSE a.steps->(s.idx-1) END
  FROM public.store_automations a
  CROSS JOIN LATERAL generate_series(0, jsonb_array_length(a.steps)) AS s(idx)
  WHERE a.store_id = NEW.store_id AND a.active AND a.trigger_event = ANY(kinds)
  ON CONFLICT (automation_id, order_id, step_index) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION public.advance_store_automation_step() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL THEN
    UPDATE public.store_automation_runs r
    SET send_at=NEW.sent_at+make_interval(mins=>LEAST(10080,GREATEST(0,COALESCE((r.definition->>'delay_minutes')::int,0))))
    WHERE r.automation_id=NEW.automation_id AND r.order_id=NEW.order_id AND r.step_index=NEW.step_index+1 AND r.sent_at IS NULL AND r.skipped IS NULL;
  ELSIF (NEW.skipped IS NOT NULL AND OLD.skipped IS NULL) OR (NEW.attempts>=5 AND OLD.attempts<5) THEN
    UPDATE public.store_automation_runs r SET skipped='previous_step_unsent'
    WHERE r.automation_id=NEW.automation_id AND r.order_id=NEW.order_id AND r.step_index>NEW.step_index AND r.sent_at IS NULL AND r.skipped IS NULL;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS store_automation_step_advance ON public.store_automation_runs;
CREATE TRIGGER store_automation_step_advance AFTER UPDATE OF sent_at,skipped,attempts ON public.store_automation_runs
FOR EACH ROW EXECUTE FUNCTION public.advance_store_automation_step();
UPDATE public.store_automation_runs r SET definition=CASE WHEN r.step_index=0 THEN to_jsonb(a)-'steps' ELSE a.steps->(r.step_index-1) END
FROM public.store_automations a WHERE a.id=r.automation_id AND r.definition IS NULL;
UPDATE public.store_automation_runs r SET send_at='infinity'::timestamptz
WHERE r.step_index>0 AND r.sent_at IS NULL AND r.skipped IS NULL
AND EXISTS(SELECT 1 FROM public.store_automation_runs p WHERE p.automation_id=r.automation_id AND p.order_id=r.order_id AND p.step_index=r.step_index-1 AND p.sent_at IS NULL);
COMMIT;
