-- Idempotent delivery integrity upgrade; retain the most recently updated locality.
ALTER TABLE public.store_delivery_integrations ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;
DELETE FROM public.delivery_provider_localities a USING public.delivery_provider_localities b
WHERE a.provider_code=b.provider_code AND a.locality_id=b.locality_id
AND (COALESCE(a.updated_at, a.created_at, '-infinity'::timestamptz), a.id)
  < (COALESCE(b.updated_at, b.created_at, '-infinity'::timestamptz), b.id);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_provider_localities_provider_locality_key
ON public.delivery_provider_localities(provider_code, locality_id);
-- Fail loudly if historical active duplicates need operator reconciliation; never discard carrier records.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_shipments_one_active_order
ON public.delivery_shipments(order_id) WHERE COALESCE(status,'') NOT IN ('failed','cancelled','canceled');
