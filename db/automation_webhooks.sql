-- Seller automation webhooks (Zapier / Make). URLs are private: no REST policy, Node functions only.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_automation_webhooks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('zapier','make')),
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_status integer,
  last_error text,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, provider)
);
GRANT ALL ON public.store_automation_webhooks TO CURRENT_USER;
ALTER TABLE public.store_automation_webhooks ENABLE ROW LEVEL SECURITY;

-- Outbox: one row per order event, written only for shops with an enabled webhook.
CREATE TABLE IF NOT EXISTS public.automation_events (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  event text NOT NULL,
  order_id uuid NOT NULL,
  data jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.automation_events TO CURRENT_USER;
GRANT USAGE, SELECT ON SEQUENCE public.automation_events_id_seq TO CURRENT_USER;
ALTER TABLE public.automation_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS automation_events_pending ON public.automation_events(next_attempt_at) WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION public.record_automation_order_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kind text;
BEGIN
  IF NEW.status = 'abandoned' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_automation_webhooks w WHERE w.store_id = NEW.store_id AND w.enabled) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status = 'abandoned') THEN kind := 'order.created';
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.delivery_status IS DISTINCT FROM OLD.delivery_status
     OR NEW.payment_status IS DISTINCT FROM OLD.payment_status OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number THEN kind := 'order.updated';
  END IF;
  IF kind IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.automation_events(store_id, event, order_id, data) VALUES (NEW.store_id, kind, NEW.id, jsonb_build_object(
    'id', NEW.id, 'order_number', NEW.order_number, 'status', NEW.status, 'delivery_status', NEW.delivery_status,
    'payment_status', NEW.payment_status, 'amount', NEW.amount, 'delivery_fee', NEW.delivery_fee, 'currency', NEW.currency,
    'customer_name', NEW.client_name, 'customer_phone', NEW.client_phone, 'address', NEW.address, 'city', NEW.city,
    'region', NEW.region, 'product_name', NEW.product_name, 'quantity', NEW.quantity, 'tracking_number', NEW.tracking_number,
    'notes', NEW.notes, 'created_at', NEW.created_at));
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS automation_order_event ON public.orders;
CREATE TRIGGER automation_order_event AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.record_automation_order_event();
COMMIT;
