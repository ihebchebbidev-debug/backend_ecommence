-- Sell-more features (offers, photo reviews, upsells). External Node/PostgreSQL migration.
BEGIN;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS offer_discount numeric DEFAULT 0 NOT NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS offer_snapshot jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS upsell_added_at timestamptz;
ALTER TABLE public.product_reviews ADD COLUMN IF NOT EXISTS store_id uuid;
ALTER TABLE public.product_reviews ADD COLUMN IF NOT EXISTS reply text;
ALTER TABLE public.product_reviews ADD COLUMN IF NOT EXISTS photos jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE public.product_reviews ADD COLUMN IF NOT EXISTS verified_purchase boolean DEFAULT false NOT NULL;
ALTER TABLE public.product_reviews ADD COLUMN IF NOT EXISTS customer_city text;
CREATE INDEX IF NOT EXISTS product_reviews_product_status ON public.product_reviews(product_id, status);
COMMIT;
