-- Loyalty programme (points on delivered orders, VIP levels, reward coupons) and
-- seller email marketing (own SMTP, block-built campaigns). Private tables: Node RPCs only.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_loyalty_settings (
  store_id uuid PRIMARY KEY REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  points_per_unit numeric NOT NULL DEFAULT 1 CHECK (points_per_unit >= 0 AND points_per_unit <= 100),
  reward_points integer NOT NULL DEFAULT 100 CHECK (reward_points BETWEEN 1 AND 1000000),
  reward_type text NOT NULL DEFAULT 'fixed' CHECK (reward_type IN ('fixed','percentage')),
  reward_value numeric NOT NULL DEFAULT 10 CHECK (reward_value > 0),
  enabled_at timestamptz,
  silver_points integer NOT NULL DEFAULT 500,
  gold_points integer NOT NULL DEFAULT 1500,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.store_loyalty_accounts (
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text NOT NULL DEFAULT '',
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  lifetime_points integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, phone)
);
-- One earn row per order, so a status flip-flop never awards twice.
CREATE TABLE IF NOT EXISTS public.store_loyalty_ledger (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  phone text NOT NULL,
  order_id uuid,
  points integer NOT NULL,
  reason text NOT NULL,
  coupon_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_loyalty_ledger_order ON public.store_loyalty_ledger(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_loyalty_ledger_phone ON public.store_loyalty_ledger(store_id, phone, created_at DESC);

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
ALTER TABLE public.store_loyalty_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_email_unsubscribes ENABLE ROW LEVEL SECURITY;
COMMIT;
