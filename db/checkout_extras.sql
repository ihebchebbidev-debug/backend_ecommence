-- Seller checkout fields answers saved on each order.
BEGIN;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS checkout_answers jsonb;
ALTER TABLE public.store_custom_fields ADD COLUMN IF NOT EXISTS placeholder text;
COMMIT;
