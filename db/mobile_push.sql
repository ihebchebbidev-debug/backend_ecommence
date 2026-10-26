-- Phone (push) notifications for the native seller app.
-- Not exposed through REST (default deny); access only via mobile_*_push RPCs and the push worker.

CREATE TABLE IF NOT EXISTS public.push_devices (
  "id"           uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id"      uuid NOT NULL,
  "store_id"     uuid NOT NULL,
  "token"        text NOT NULL,
  "platform"     text NOT NULL,
  "language"     text DEFAULT 'fr' NOT NULL,
  "created_at"   timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at"   timestamptz,
  CONSTRAINT push_devices_pkey PRIMARY KEY ("id"),
  CONSTRAINT push_devices_token_key UNIQUE ("token")
);
CREATE INDEX IF NOT EXISTS push_devices_active_idx ON public.push_devices (store_id, user_id) WHERE revoked_at IS NULL;
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;

-- One row per (notification, device): the claim makes every send at-most-once, even across restarts.
CREATE TABLE IF NOT EXISTS public.push_deliveries (
  "notification_id" uuid NOT NULL,
  "device_id"       uuid NOT NULL,
  "status"          text DEFAULT 'claimed' NOT NULL,
  "created_at"      timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT push_deliveries_pkey PRIMARY KEY ("notification_id", "device_id")
);
ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;
