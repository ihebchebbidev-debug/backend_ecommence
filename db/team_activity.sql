-- Team member sign-in tracking and activity details.
BEGIN;
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS team_member_id uuid;
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE public.activity_log ALTER COLUMN created_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_activity_log_store_created ON public.activity_log (store_id, created_at DESC);
COMMIT;
