-- Consent is recorded by validated checkout, never by a public reporting request.
BEGIN;
ALTER TABLE public.ad_match_consents ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.ad_match_consents ADD COLUMN IF NOT EXISTS recorded_at_checkout boolean NOT NULL DEFAULT false;
COMMIT;