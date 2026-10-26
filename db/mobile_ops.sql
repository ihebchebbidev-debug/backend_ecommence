-- Mobile order operations: edit history, preparation and duplicate-tap protection.
-- Tables here are not exposed through REST (default deny); access is only via mobile_* RPCs.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS prepared_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS prepared_by text;

CREATE TABLE IF NOT EXISTS public.order_events (
  "id"          uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_id"    uuid NOT NULL,
  "order_id"    uuid NOT NULL,
  "actor_kind"  text,
  "actor_id"    text,
  "actor_name"  text,
  "kind"        text NOT NULL,
  "changes"     jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT order_events_pkey PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON public.order_events (store_id, order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mobile_idempotency (
  "store_id"    uuid NOT NULL,
  "key"         text NOT NULL,
  "fn"          text NOT NULL,
  "result"      jsonb,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT mobile_idempotency_pkey PRIMARY KEY ("store_id", "key")
);

-- Every order change (web, mobile, agents, workers) lands in the timeline.
-- Actor details come from transaction-local settings set by the calling RPC; absent means "system/web".
CREATE OR REPLACE FUNCTION public.order_events_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  diff jsonb := '{}'::jsonb;
  col text;
  kind text := 'edit';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_events(store_id, order_id, actor_kind, actor_id, actor_name, kind, changes)
    VALUES (NEW.store_id, NEW.id, nullif(current_setting('app.actor_kind', true), ''), nullif(current_setting('app.actor_id', true), ''),
      nullif(current_setting('app.actor_name', true), ''), 'created', jsonb_build_object('status', jsonb_build_object('to', NEW.status)));
    RETURN NEW;
  END IF;
  FOREACH col IN ARRAY ARRAY['status','client_name','client_phone','city','address','notes','amount','delivery_status','prepared_at','deleted_at'] LOOP
    IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col) THEN
      diff := diff || jsonb_build_object(col, jsonb_build_object('from', to_jsonb(OLD) -> col, 'to', to_jsonb(NEW) -> col));
    END IF;
  END LOOP;
  IF diff = '{}'::jsonb THEN RETURN NEW; END IF;
  IF diff ? 'deleted_at' THEN kind := CASE WHEN NEW.deleted_at IS NULL THEN 'restored' ELSE 'trashed' END;
  ELSIF diff ? 'prepared_at' THEN kind := 'prepared';
  ELSIF diff ? 'status' AND (SELECT count(*) FROM jsonb_object_keys(diff)) = 1 THEN kind := 'status';
  END IF;
  INSERT INTO public.order_events(store_id, order_id, actor_kind, actor_id, actor_name, kind, changes)
  VALUES (NEW.store_id, NEW.id, nullif(current_setting('app.actor_kind', true), ''), nullif(current_setting('app.actor_id', true), ''),
    nullif(current_setting('app.actor_name', true), ''), kind, diff);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_events_capture ON public.orders;
CREATE TRIGGER order_events_capture AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.order_events_capture();

-- Server-only tables: the Node API connects as the owner role; no client role gets direct access.
REVOKE ALL ON public.order_events FROM PUBLIC;
REVOKE ALL ON public.mobile_idempotency FROM PUBLIC;
