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
-- Stock held by a checkout order: no row (or released=false) means its lines are reserved.
CREATE TABLE IF NOT EXISTS public.order_stock_state (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  released boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.order_stock_state TO CURRENT_USER;
ALTER TABLE public.order_stock_state ENABLE ROW LEVEL SECURITY;
-- Orders already refunded by the former cancellation rule stay released (never refunded twice).
INSERT INTO public.order_stock_state(order_id, released)
SELECT n.source_id, true FROM public.commerce_notifications n JOIN public.orders o ON o.id = n.source_id
WHERE n.type = 'order_cancelled' ON CONFLICT (order_id) DO NOTHING;
-- The external API runs as the owning database role; tables are denied over generic REST.
-- No anonymous/authenticated grants or policies: clients must use authorized Node RPCs.
CREATE OR REPLACE FUNCTION public.record_commerce_order_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kind text; payload jsonb; changed int; old_holds boolean; new_holds boolean;
  releasing text[] := ARRAY['cancelled','canceled','rejected','returned'];
  consumed text[] := ARRAY['shipped','transit','in_transit','delivered'];
BEGIN
  IF NEW.status = 'abandoned' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status = 'abandoned') THEN kind := 'order_created';
  ELSIF NEW.status IN ('cancelled','canceled') AND OLD.status IS DISTINCT FROM NEW.status THEN kind := 'order_cancelled';
  END IF;
  payload := jsonb_build_object('order_number',NEW.order_number);
  IF kind IS NOT NULL THEN
    INSERT INTO public.commerce_notifications(store_id,type,source_id,event_key,data)
    VALUES(NEW.store_id,kind,NEW.id,kind||':'||NEW.id,payload) ON CONFLICT(event_key) DO NOTHING;
  END IF;
  -- Checkout orders reserve stock at placement. Cancel/reject/return gives it back once;
  -- reopening the order takes it again, so repeated status changes never drift inventory.
  -- Moving an unshipped order to the trash also gives its stock back, and restoring it takes
  -- the stock again; trashing a shipped/delivered order changes nothing (the goods are gone).
  IF TG_OP = 'UPDATE' AND NEW.merchandise_subtotal IS NOT NULL AND coalesce(OLD.status,'') <> 'abandoned'
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    old_holds := NOT (coalesce(OLD.status,'') = ANY(releasing)) AND (OLD.deleted_at IS NULL OR coalesce(OLD.status,'') = ANY(consumed));
    new_holds := NOT (coalesce(NEW.status,'') = ANY(releasing)) AND (NEW.deleted_at IS NULL OR coalesce(NEW.status,'') = ANY(consumed));
    IF old_holds AND NOT new_holds THEN
      INSERT INTO public.order_stock_state(order_id, released) VALUES (NEW.id, true)
      ON CONFLICT (order_id) DO UPDATE SET released = true, updated_at = now() WHERE public.order_stock_state.released = false;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed > 0 THEN
        UPDATE public.products p SET stock = p.stock + i.qty
        FROM (SELECT product_id, sum(quantity)::int AS qty FROM public.order_items WHERE order_id = NEW.id AND product_id IS NOT NULL GROUP BY product_id) i
        WHERE p.id = i.product_id AND p.stock IS NOT NULL;
      END IF;
    ELSIF new_holds AND NOT old_holds THEN
      UPDATE public.order_stock_state SET released = false, updated_at = now() WHERE order_id = NEW.id AND released;
      IF FOUND THEN
        UPDATE public.products p SET stock = p.stock - i.qty
        FROM (SELECT product_id, sum(quantity)::int AS qty FROM public.order_items WHERE order_id = NEW.id AND product_id IS NOT NULL GROUP BY product_id) i
        WHERE p.id = i.product_id AND p.stock IS NOT NULL;
      END IF;
    END IF;
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
