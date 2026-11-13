-- A/B testing: one product per experiment, up to 11 variants (A = original).
-- Read and written only through rpc/experiments.js (REST denied), which checks shop and permissions.
CREATE TABLE IF NOT EXISTS public.store_experiments (
  "id"                uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_id"          uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  "name"              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  "status"            text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft','running','paused','completed')),
  "target_type"       text DEFAULT 'product' NOT NULL CHECK (target_type IN ('product','sales_page','checkout_form')),
  "product_id"        uuid,
  "sales_page_id"     uuid,
  "primary_metric"    text DEFAULT 'orders' NOT NULL CHECK (primary_metric IN ('orders','confirmed')),
  "started_at"        timestamptz,
  "paused_at"         timestamptz,
  "ended_at"          timestamptz,
  "winner_key"        text,
  "applied_winner"    boolean DEFAULT false NOT NULL,
  "applied_fields"    jsonb,
  "backup_product_id" uuid,
  "version"           integer DEFAULT 1 NOT NULL,
  "created_by"        uuid,
  "created_at"        timestamptz DEFAULT now() NOT NULL,
  "updated_at"        timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_experiments_pkey PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS store_experiments_store_idx ON public.store_experiments (store_id, created_at DESC);
-- One running or paused experiment per product, enforced by the database, not only the screen.
CREATE UNIQUE INDEX IF NOT EXISTS store_experiments_active_product_uidx
  ON public.store_experiments (store_id, product_id) WHERE status IN ('running','paused');

CREATE TABLE IF NOT EXISTS public.store_experiment_variants (
  "experiment_id"   uuid NOT NULL REFERENCES public.store_experiments(id) ON DELETE CASCADE,
  "key"             text NOT NULL CHECK (key ~ '^[A-K]$'),
  "name"            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  "is_control"      boolean DEFAULT false NOT NULL,
  "traffic_pct"     integer NOT NULL CHECK (traffic_pct BETWEEN 1 AND 99),
  "overrides"       jsonb DEFAULT '{}'::jsonb NOT NULL,
  "change_keys"     text[] DEFAULT '{}'::text[] NOT NULL,
  "source_snapshot" jsonb,
  CONSTRAINT store_experiment_variants_pkey PRIMARY KEY ("experiment_id", "key")
);

-- One row per visitor and experiment: the sticky assignment and the visitor count.
CREATE TABLE IF NOT EXISTS public.store_experiment_exposures (
  "experiment_id" uuid NOT NULL REFERENCES public.store_experiments(id) ON DELETE CASCADE,
  "visitor_id"    text NOT NULL,
  "variant_key"   text NOT NULL,
  "first_seen_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at"  timestamptz DEFAULT now() NOT NULL,
  "device"        text,
  "utm_source"    text,
  "utm_campaign"  text,
  "ad_id"         text,
  CONSTRAINT store_experiment_exposures_pkey PRIMARY KEY ("experiment_id", "visitor_id")
);
CREATE INDEX IF NOT EXISTS store_experiment_exposures_variant_idx ON public.store_experiment_exposures (experiment_id, variant_key, first_seen_at);

-- Funnel events, de-duplicated per visitor/event/day (V2 screens read these).
CREATE TABLE IF NOT EXISTS public.store_experiment_events (
  "experiment_id" uuid NOT NULL REFERENCES public.store_experiments(id) ON DELETE CASCADE,
  "variant_key"   text NOT NULL,
  "visitor_id"    text NOT NULL,
  "day"           date NOT NULL,
  "event"         text NOT NULL CHECK (event IN ('view','add_to_cart','checkout_started','phone_captured')),
  CONSTRAINT store_experiment_events_pkey PRIMARY KEY ("experiment_id", "visitor_id", "event", "day")
);

-- Orders (and unfinished checkouts) remember the variant whose price the server charged.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS experiment_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS experiment_variant text;
CREATE INDEX IF NOT EXISTS orders_experiment_idx ON public.orders (experiment_id, experiment_variant) WHERE experiment_id IS NOT NULL;

-- V2: more testable product details (also written when a winner is applied).
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS compare_at_price numeric;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS gallery jsonb;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS landing_only boolean DEFAULT false NOT NULL;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS checkout_position text;

-- V2: money metrics, optional auto-stop, sales-page / order-form targets.
ALTER TABLE public.store_experiments DROP CONSTRAINT IF EXISTS store_experiments_primary_metric_check;
ALTER TABLE public.store_experiments ADD CONSTRAINT store_experiments_primary_metric_check CHECK (primary_metric IN ('orders','confirmed','delivered_revenue','profit'));
ALTER TABLE public.store_experiments ADD COLUMN IF NOT EXISTS auto_stop boolean DEFAULT false NOT NULL;
ALTER TABLE public.store_experiments ADD COLUMN IF NOT EXISTS auto_stopped boolean DEFAULT false NOT NULL;
ALTER TABLE public.store_experiments ADD COLUMN IF NOT EXISTS winner_history jsonb DEFAULT '[]'::jsonb NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS store_experiments_active_page_uidx
  ON public.store_experiments (store_id, sales_page_id) WHERE status IN ('running','paused') AND target_type = 'sales_page';
CREATE UNIQUE INDEX IF NOT EXISTS store_experiments_active_form_uidx
  ON public.store_experiments (store_id) WHERE status IN ('running','paused') AND target_type = 'checkout_form';

-- Orders keep the visitor whose signed assignment priced them, so results can be filtered by source/device.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS experiment_visitor_id text;
