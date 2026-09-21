-- =====================================================================
-- nodejs_backend/db/auth_schema.sql
-- The `auth` schema the Node.js backend owns itself (replaces GoTrue).
-- Apply AFTER schema.sql.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;

BEGIN;

CREATE TABLE IF NOT EXISTS auth.users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     text UNIQUE,
  phone                     text UNIQUE,
  encrypted_password        text,
  email_confirmed_at        timestamptz,
  phone_confirmed_at        timestamptz,
  confirmation_token        text,
  confirmation_sent_at      timestamptz,
  recovery_token            text,
  recovery_sent_at          timestamptz,
  last_sign_in_at           timestamptz,
  raw_app_meta_data         jsonb NOT NULL DEFAULT '{"provider":"email","providers":["email"]}'::jsonb,
  raw_user_meta_data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_anonymous              boolean NOT NULL DEFAULT false,
  banned_until              timestamptz,
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_agent  text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  not_after   timestamptz
);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  token       text PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  revoked     boolean NOT NULL DEFAULT false,
  parent      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_user ON auth.refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_session ON auth.refresh_tokens(session_id);

-- profiles.id references auth.users.id exactly like the live backend.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── Storage (replaces storage.objects / storage.buckets) ─────────────
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  public      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id    text NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name         text NOT NULL,
  owner        uuid,
  size         bigint NOT NULL DEFAULT 0,
  mime_type    text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);

INSERT INTO storage.buckets (id, name, public) VALUES
  ('platform-assets', 'platform-assets', true),
  ('theme-previews',  'theme-previews',  true)
ON CONFLICT (id) DO NOTHING;

COMMIT;
