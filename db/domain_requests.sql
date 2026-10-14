-- Custom domain requests from sellers. External Node/PostgreSQL migration.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_domain_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  domain text NOT NULL,
  availability text NOT NULL DEFAULT 'unknown', -- available | taken | unknown (checked when submitted)
  already_owned boolean NOT NULL DEFAULT false,
  contact_email text NOT NULL,
  contact_phone text,
  business_name text,
  notes text,
  status text NOT NULL DEFAULT 'pending', -- pending | in_progress | active | rejected | cancelled
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_domain_requests_store ON public.store_domain_requests(store_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS store_domain_requests_open_domain
  ON public.store_domain_requests(lower(domain)) WHERE status IN ('pending', 'in_progress', 'active');
COMMIT;
