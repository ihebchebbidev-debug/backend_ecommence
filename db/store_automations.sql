-- Seller message automations (SMS to the customer, email to the seller) sent through the
-- platform SMS / SMTP settings. Private tables: Node RPCs only, no REST policy.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_automations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_event text NOT NULL CHECK (trigger_event IN ('order_created','order_confirmed','order_shipped','order_delivered','order_cancelled','order_returned','payment_failed')),
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  message text NOT NULL,
  subject text NOT NULL DEFAULT '',
  email_to text NOT NULL DEFAULT '',
  delay_minutes integer NOT NULL DEFAULT 0 CHECK (delay_minutes BETWEEN 0 AND 10080),
  active boolean NOT NULL DEFAULT false,
  runs integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.store_automations TO CURRENT_USER;
ALTER TABLE public.store_automations ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS store_automations_store ON public.store_automations(store_id, trigger_event) WHERE active;

-- One scheduled send per automation and order, so a status flip-flop never sends twice.
CREATE TABLE IF NOT EXISTS public.store_automation_runs (
  id bigserial PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES public.store_automations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  send_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  skipped text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, order_id)
);
GRANT ALL ON public.store_automation_runs TO CURRENT_USER;
GRANT USAGE, SELECT ON SEQUENCE public.store_automation_runs_id_seq TO CURRENT_USER;
ALTER TABLE public.store_automation_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS store_automation_runs_due ON public.store_automation_runs(send_at) WHERE sent_at IS NULL AND skipped IS NULL;

CREATE OR REPLACE FUNCTION public.schedule_store_automations() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN kind := 'order_created';
  ELSIF NEW.payment_status = 'failed' AND OLD.payment_status IS DISTINCT FROM 'failed' THEN kind := 'payment_failed';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    kind := CASE NEW.status WHEN 'confirmed' THEN 'order_confirmed' WHEN 'shipped' THEN 'order_shipped'
      WHEN 'delivered' THEN 'order_delivered' WHEN 'cancelled' THEN 'order_cancelled' WHEN 'canceled' THEN 'order_cancelled'
      WHEN 'returned' THEN 'order_returned' END;
  ELSIF NEW.delivery_status = 'delivered' AND OLD.delivery_status IS DISTINCT FROM 'delivered' THEN kind := 'order_delivered';
  END IF;
  IF kind IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.store_automation_runs(automation_id, store_id, order_id, send_at)
  SELECT a.id, NEW.store_id, NEW.id, now() + make_interval(mins => a.delay_minutes)
  FROM public.store_automations a WHERE a.store_id = NEW.store_id AND a.active AND a.trigger_event = kind
  ON CONFLICT (automation_id, order_id) DO NOTHING;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS store_automation_schedule ON public.orders;
CREATE TRIGGER store_automation_schedule AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.schedule_store_automations();
COMMIT;
