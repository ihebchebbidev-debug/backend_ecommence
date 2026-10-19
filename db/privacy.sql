-- Seller privacy controls: bulk order deletion by period (support-restorable) and data export requests.
BEGIN;
CREATE TABLE IF NOT EXISTS public.privacy_order_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  timezone text NOT NULL,
  include_payments boolean NOT NULL DEFAULT false,
  order_ids uuid[] NOT NULL DEFAULT '{}',
  payment_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  restore_until timestamptz NOT NULL DEFAULT now() + interval '10 days',
  restored_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_privacy_order_deletions_store ON public.privacy_order_deletions (store_id, created_at DESC);
GRANT ALL ON public.privacy_order_deletions TO CURRENT_USER;
ALTER TABLE public.privacy_order_deletions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.privacy_export_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email text,
  email_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  downloaded_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_privacy_export_requests_user ON public.privacy_export_requests (user_id, created_at DESC);
GRANT ALL ON public.privacy_export_requests TO CURRENT_USER;
ALTER TABLE public.privacy_export_requests ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.privacy_data_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  timezone text NOT NULL,
  item_ids uuid[] NOT NULL DEFAULT '{}',
  snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  restore_until timestamptz NOT NULL DEFAULT now() + interval '10 days',
  restored_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_privacy_data_deletions_store ON public.privacy_data_deletions (store_id, kind, created_at DESC);
GRANT ALL ON public.privacy_data_deletions TO CURRENT_USER;
ALTER TABLE public.privacy_data_deletions ENABLE ROW LEVEL SECURITY;
COMMIT;
