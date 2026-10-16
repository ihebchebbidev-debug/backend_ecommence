-- Platform email (SMTP) + SMS provider settings and account verification codes.
-- Both tables are private: no REST policy, only admin RPCs and the auth router touch them.
BEGIN;
CREATE TABLE IF NOT EXISTS public.platform_messaging_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  smtp_enabled boolean NOT NULL DEFAULT false,
  smtp_preset text NOT NULL DEFAULT 'godaddy',
  smtp_host text NOT NULL DEFAULT 'smtp.office365.com',
  smtp_port integer NOT NULL DEFAULT 587,
  smtp_secure boolean NOT NULL DEFAULT false,
  smtp_user text NOT NULL DEFAULT 'contact@e-commence.shop',
  smtp_pass text NOT NULL DEFAULT '',
  smtp_from_email text NOT NULL DEFAULT 'contact@e-commence.shop',
  smtp_from_name text NOT NULL DEFAULT 'e-commence',
  sms_enabled boolean NOT NULL DEFAULT false,
  sms_provider text NOT NULL DEFAULT 'twilio',
  sms_account_id text NOT NULL DEFAULT '',
  sms_secret text NOT NULL DEFAULT '',
  sms_sender text NOT NULL DEFAULT '',
  sms_base_url text NOT NULL DEFAULT '',
  otp_signup_email boolean NOT NULL DEFAULT false,
  otp_signup_sms boolean NOT NULL DEFAULT false,
  otp_signin_email boolean NOT NULL DEFAULT false,
  otp_signin_sms boolean NOT NULL DEFAULT false,
  otp_reset_email boolean NOT NULL DEFAULT false,
  otp_reset_sms boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
GRANT ALL ON public.platform_messaging_settings TO CURRENT_USER;
ALTER TABLE public.platform_messaging_settings ENABLE ROW LEVEL SECURITY;
INSERT INTO public.platform_messaging_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.auth_otp_codes (
  id bigserial PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('signup','signin','reset')),
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  target text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  ip text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.auth_otp_codes TO CURRENT_USER;
GRANT USAGE, SELECT ON SEQUENCE public.auth_otp_codes_id_seq TO CURRENT_USER;
ALTER TABLE public.auth_otp_codes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS auth_otp_codes_lookup ON public.auth_otp_codes (purpose, channel, target, created_at DESC);
COMMIT;
