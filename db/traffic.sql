-- Platform-wide traffic counter: one row per page view on the platform website,
-- seller app and every shop. Readable only through super-admin RPCs (REST denied),
-- because rows hold visitor IP addresses.
CREATE TABLE IF NOT EXISTS public.site_visits (
  "id"             uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at"     timestamptz DEFAULT now() NOT NULL,
  "session_id"     text,
  "ip"             text,
  "country"        text,
  "region"         text,
  "city"           text,
  "timezone"       text,
  "path"           text NOT NULL,
  "host"           text,
  "referrer"       text,
  "referrer_host"  text,
  "area"           text DEFAULT 'platform' NOT NULL,
  "store_id"       uuid,
  "user_id"        uuid,
  "device"         text,
  "browser"        text,
  "os"             text,
  "lang"           text,
  "user_agent"     text,
  "visitor_id"     text,
  "is_new_visitor" boolean,
  "page_title"     text,
  "utm_source"     text,
  "utm_medium"     text,
  "utm_campaign"   text,
  "click_id"       text,
  "screen"         text,
  "viewport"       text,
  "pixel_ratio"    numeric,
  "browser_tz"     text,
  "languages"      text,
  "connection"     text,
  "browser_version" text,
  "os_version"     text,
  "device_model"   text,
  "load_ms"        integer,
  "duration_ms"    integer,
  "scroll_pct"     integer,
  CONSTRAINT site_visits_pkey PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS site_visits_created_idx ON public.site_visits (created_at DESC);
CREATE INDEX IF NOT EXISTS site_visits_country_idx ON public.site_visits (country, created_at DESC);
CREATE INDEX IF NOT EXISTS site_visits_store_idx ON public.site_visits (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS site_visits_ip_idx ON public.site_visits (ip);

-- Columns added after the first release (kept for databases created before them).
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS is_new_visitor boolean;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS page_title text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS screen text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS viewport text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS pixel_ratio numeric;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS browser_tz text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS languages text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS connection text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS browser_version text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS os_version text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS device_model text;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS load_ms integer;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE public.site_visits ADD COLUMN IF NOT EXISTS scroll_pct integer;
CREATE INDEX IF NOT EXISTS site_visits_session_idx ON public.site_visits (session_id, created_at);
CREATE INDEX IF NOT EXISTS site_visits_visitor_idx ON public.site_visits (visitor_id, created_at);

-- Server (API) request log: one row per backend request, written in batches by
-- src/lib/apiLog.js. Super-admin RPCs only (REST denied); kept 30 days by default.
CREATE TABLE IF NOT EXISTS public.api_request_logs (
  "id"          bigserial NOT NULL,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  "req_id"      text,
  "method"      text NOT NULL,
  "path"        text NOT NULL,
  "endpoint"    text NOT NULL,
  "status"      integer NOT NULL,
  "ms"          integer NOT NULL,
  "ip"          text,
  "country"     text,
  "user_id"     uuid,
  "role"        text,
  "origin"      text,
  "browser"     text,
  "os"          text,
  "device"      text,
  "user_agent"  text,
  "error"       text,
  CONSTRAINT api_request_logs_pkey PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS api_request_logs_created_idx ON public.api_request_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_logs_endpoint_idx ON public.api_request_logs (endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_logs_ip_idx ON public.api_request_logs (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_logs_status_idx ON public.api_request_logs (status, created_at DESC);
