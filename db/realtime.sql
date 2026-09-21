-- =====================================================================
-- nodejs_backend/db/realtime.sql
-- Replaces the Supabase realtime publication. Only `orders` is published,
-- matching the live backend (channel `orders-new-{storeId}`).
-- Apply AFTER schema.sql.
-- =====================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.notify_realtime_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payload jsonb;
  rec     jsonb;
BEGIN
  rec := to_jsonb(COALESCE(NEW, OLD));
  payload := jsonb_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table',  TG_TABLE_NAME,
    'type',   TG_OP,                                  -- INSERT | UPDATE | DELETE
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    'store_id', rec ->> 'store_id',
    'commit_timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  -- pg_notify has an 8000-byte payload limit; drop the row on overflow.
  IF octet_length(payload::text) > 7500 THEN
    payload := payload - 'record' - 'old_record';
  END IF;
  PERFORM pg_notify('realtime_changes', payload::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Publishing a table takes one call: SELECT public.enable_realtime('products');
-- The server does this on boot for every table in REALTIME_TABLES.
CREATE OR REPLACE FUNCTION public.enable_realtime(p_table text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  trig text := 'realtime_' || p_table;
BEGIN
  IF p_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid table name %', p_table;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = p_table
  ) THEN
    RETURN false;
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trig, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.notify_realtime_change()', trig, p_table);
  RETURN true;
END;
$$;

SELECT public.enable_realtime('orders');

COMMIT;
