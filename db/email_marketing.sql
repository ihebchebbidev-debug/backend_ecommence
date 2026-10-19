-- Seller email marketing (own SMTP, block-built campaigns, unsubscribes). Private tables: Node RPCs only.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_email_settings (
  store_id uuid PRIMARY KEY REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  smtp_host text NOT NULL DEFAULT '',
  smtp_port integer NOT NULL DEFAULT 587,
  smtp_secure boolean NOT NULL DEFAULT false,
  smtp_user text NOT NULL DEFAULT '',
  smtp_pass text NOT NULL DEFAULT '',
  from_email text NOT NULL DEFAULT '',
  from_name text NOT NULL DEFAULT '',
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.store_email_campaigns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  preheader text NOT NULL DEFAULT '',
  accent text NOT NULL DEFAULT '#15803d',
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent')),
  total integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_email_campaigns_store ON public.store_email_campaigns(store_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.store_email_recipients (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES public.store_email_campaigns(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  error text,
  UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS store_email_recipients_due ON public.store_email_recipients(campaign_id) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS public.store_email_unsubscribes (
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, email)
);
ALTER TABLE public.store_email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_unsubscribes ENABLE ROW LEVEL SECURITY;
COMMIT;
