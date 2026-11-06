-- Every payment reference ever issued for an order stays matchable, so a shopper who
-- pays through an earlier link (checkout opened twice) still settles the order.
CREATE TABLE IF NOT EXISTS public.order_payment_refs (
  "payment_ref"                      text NOT NULL,
  "order_id"                         uuid NOT NULL,
  "store_id"                         uuid NOT NULL,
  "provider"                         text,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT order_payment_refs_pkey PRIMARY KEY ("payment_ref")
);
CREATE INDEX IF NOT EXISTS order_payment_refs_order_idx ON public.order_payment_refs (order_id);

CREATE OR REPLACE FUNCTION public.remember_order_payment_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_ref IS NOT NULL AND NEW.payment_ref <> '' THEN
    INSERT INTO public.order_payment_refs (payment_ref, order_id, store_id, provider)
    VALUES (NEW.payment_ref, NEW.id, NEW.store_id, NEW.payment_provider)
    ON CONFLICT (payment_ref) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS orders_remember_payment_ref ON public.orders;
CREATE TRIGGER orders_remember_payment_ref AFTER INSERT OR UPDATE OF payment_ref ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.remember_order_payment_ref();

-- New orders always carry their shop's currency, whatever path creates them
-- (manual seller form, REST, mobile, checkout), so amounts are never relabelled TND.
CREATE OR REPLACE FUNCTION public.orders_shop_currency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shop_currency text;
BEGIN
  SELECT NULLIF(upper(trim(currency)), '') INTO shop_currency FROM public.platform_stores WHERE id = NEW.store_id;
  IF shop_currency IS NOT NULL THEN NEW.currency := shop_currency; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS orders_shop_currency ON public.orders;
CREATE TRIGGER orders_shop_currency BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.orders_shop_currency();
