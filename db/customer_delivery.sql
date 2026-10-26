-- Explicit customer-managed delivery is independent of shipment status.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_handles_delivery boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_customer_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE managed boolean;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    IF NEW.customer_handles_delivery THEN
      IF EXISTS (SELECT 1 FROM public.delivery_shipments WHERE order_id=NEW.id
        AND COALESCE(status,'') NOT IN ('failed','cancelled','canceled')) THEN
        RAISE EXCEPTION 'Cancel the existing shipment before selecting customer-managed delivery';
      END IF;
    END IF;
  ELSE
    -- Serialize with order edits, including generic REST shipment writes.
    SELECT customer_handles_delivery INTO managed FROM public.orders WHERE id=NEW.order_id FOR UPDATE;
    IF managed AND COALESCE(NEW.status,'') NOT IN ('failed','cancelled','canceled') THEN
      RAISE EXCEPTION 'Customer handles delivery; carrier dispatch is disabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS orders_customer_delivery_guard ON public.orders;
CREATE TRIGGER orders_customer_delivery_guard BEFORE INSERT OR UPDATE OF customer_handles_delivery ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_delivery();
DROP TRIGGER IF EXISTS shipments_customer_delivery_guard ON public.delivery_shipments;
CREATE TRIGGER shipments_customer_delivery_guard BEFORE INSERT OR UPDATE ON public.delivery_shipments
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_delivery();