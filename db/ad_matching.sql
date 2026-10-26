-- Shopper agreement to share order contact details with Facebook for ad measurement,
-- plus a durable record of conversion events already reported (dedup across restarts).
BEGIN;
CREATE TABLE IF NOT EXISTS public.ad_match_consents (
  order_id       uuid PRIMARY KEY,
  store_id       uuid NOT NULL,
  accepted       boolean NOT NULL,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  notice_version integer NOT NULL,
  notice_text    text NOT NULL,
  email_sha256   text,
  withdrawn_at   timestamptz
);
CREATE INDEX IF NOT EXISTS ad_match_consents_store_idx ON public.ad_match_consents (store_id);

CREATE TABLE IF NOT EXISTS public.meta_capi_sent (
  store_id   uuid NOT NULL,
  event_id   text NOT NULL,
  event_name text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, event_name, event_id)
);
COMMIT;

-- Seller's Meta Conversions API access token: private table (never readable over REST),
-- because store_settings is publicly readable by shop visitors.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_meta_capi (
  store_id        uuid PRIMARY KEY,
  access_token    text NOT NULL,
  test_event_code text,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.store_meta_capi (store_id, access_token)
  SELECT store_id, value FROM public.store_settings
   WHERE key = 'meta_access_token' AND coalesce(value, '') <> '' AND store_id IS NOT NULL
  ON CONFLICT (store_id) DO NOTHING;
DELETE FROM public.store_settings WHERE key = 'meta_access_token';
COMMIT;
