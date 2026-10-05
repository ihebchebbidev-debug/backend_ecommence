-- External Node/PostgreSQL migration; never apply to the isolated Cloud database.
BEGIN;
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS merchandise_subtotal numeric;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0 NOT NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS coupon_code text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS checkout_request_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS checkout_fingerprint text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0 NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_checkout_request_unique ON public.orders(store_id,checkout_request_id) WHERE checkout_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coupons_normalized_lookup ON public.coupons(store_id,upper(trim(code)));
CREATE TABLE IF NOT EXISTS public.commerce_notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  type text NOT NULL,
  source_id uuid NOT NULL,
  event_key text NOT NULL UNIQUE,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.commerce_notifications TO CURRENT_USER;
ALTER TABLE public.commerce_notifications ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS commerce_notifications_feed ON public.commerce_notifications(store_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS public.commerce_notification_reads (
  notification_id uuid NOT NULL REFERENCES public.commerce_notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(notification_id,user_id)
);
GRANT ALL ON public.commerce_notification_reads TO CURRENT_USER;
ALTER TABLE public.commerce_notification_reads ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id),
  coupon_id uuid NOT NULL REFERENCES public.coupons(id),
  store_id uuid NOT NULL REFERENCES public.platform_stores(id),
  code text NOT NULL,
  discount_amount numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.coupon_redemptions TO CURRENT_USER;
ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.commerce_attempts (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL
);
GRANT ALL ON public.commerce_attempts TO CURRENT_USER;
ALTER TABLE public.commerce_attempts ENABLE ROW LEVEL SECURITY;
-- The external API runs as the owning database role; tables are denied over generic REST.
-- No anonymous/authenticated grants or policies: clients must use authorized Node RPCs.
CREATE OR REPLACE FUNCTION public.record_commerce_order_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kind text; payload jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN kind := 'order_created';
  ELSIF NEW.status IN ('cancelled','canceled') AND OLD.status IS DISTINCT FROM NEW.status THEN kind := 'order_cancelled';
  END IF;
  payload := jsonb_build_object('order_number',NEW.order_number);
  IF kind IS NOT NULL THEN
    INSERT INTO public.commerce_notifications(store_id,type,source_id,event_key,data)
    VALUES(NEW.store_id,kind,NEW.id,kind||':'||NEW.id,payload) ON CONFLICT(event_key) DO NOTHING;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
    INSERT INTO public.commerce_notifications(store_id,type,source_id,event_key,data)
    VALUES(NEW.store_id,'payment_received',NEW.id,'payment_received:'||NEW.id,
      payload||jsonb_build_object('amount',NEW.amount,'currency',NEW.currency)) ON CONFLICT(event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS commerce_order_event ON public.orders;
CREATE TRIGGER commerce_order_event AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.record_commerce_order_event();
CREATE OR REPLACE FUNCTION public.record_commerce_stock_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.stock IS NOT NULL AND NEW.stock <= 3 AND (OLD.stock IS NULL OR OLD.stock > 3) THEN
    INSERT INTO public.commerce_notifications(store_id,type,source_id,event_key,data)
    VALUES(NEW.store_id,'low_stock',NEW.id,'low_stock:'||NEW.id||':'||gen_random_uuid(),
      jsonb_build_object('product_name',NEW.name,'stock',NEW.stock));
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS commerce_stock_event ON public.products;
CREATE TRIGGER commerce_stock_event AFTER UPDATE OF stock ON public.products FOR EACH ROW EXECUTE FUNCTION public.record_commerce_stock_event();
COMMIT;
