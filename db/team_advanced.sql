-- Advanced team: multi-shop members, confirmation agents, and automatic
-- activity log for product / stock / design changes (every write path).
BEGIN;

ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS is_confirmation_agent boolean NOT NULL DEFAULT false;
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS store_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.agent_sessions ADD COLUMN IF NOT EXISTS allowed_store_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.agent_sessions ADD COLUMN IF NOT EXISTS is_confirmation_agent boolean NOT NULL DEFAULT false;

-- Actor comes from the team RPC (set_config 'app.actor_name' / 'app.actor_member_id');
-- anything else (owner editor, REST) is recorded as the shop owner.
CREATE OR REPLACE FUNCTION public._team_activity_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_store uuid;
  v_action text;
  v_details text;
  v_type text := TG_ARGV[0];
  v_actor text := NULLIF(current_setting('app.actor_name', true), '');
  v_member uuid := NULLIF(current_setting('app.actor_member_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  v_store := (to_jsonb(r) ->> 'store_id')::uuid;
  IF v_store IS NULL THEN RETURN NULL; END IF;

  IF v_type = 'product' THEN
    IF TG_OP = 'INSERT' THEN
      v_action := 'product_create'; v_details := 'Produit créé : ' || COALESCE(NEW.name, '');
    ELSIF TG_OP = 'DELETE' THEN
      v_action := 'product_delete'; v_details := 'Produit supprimé : ' || COALESCE(OLD.name, '');
    ELSIF (to_jsonb(OLD) ->> 'deleted_at') IS NULL AND (to_jsonb(NEW) ->> 'deleted_at') IS NOT NULL THEN
      v_action := 'product_delete'; v_details := 'Produit supprimé : ' || COALESCE(NEW.name, '');
    ELSIF OLD.stock IS DISTINCT FROM NEW.stock THEN
      v_action := 'stock_update';
      v_details := 'Stock ' || COALESCE(NEW.name, '') || ' : ' || COALESCE(OLD.stock::text, '—') || ' → ' || COALESCE(NEW.stock::text, '—');
    ELSE
      IF to_jsonb(OLD) - 'updated_at' = to_jsonb(NEW) - 'updated_at' THEN RETURN NULL; END IF;
      v_action := 'product_update'; v_details := 'Produit modifié : ' || COALESCE(NEW.name, '');
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND to_jsonb(OLD) - 'updated_at' = to_jsonb(NEW) - 'updated_at' THEN RETURN NULL; END IF;
    v_action := 'design_update';
    v_details := CASE TG_TABLE_NAME
      WHEN 'store_theme' THEN 'Design de la boutique modifié'
      WHEN 'store_theme_instances' THEN 'Thème de la boutique modifié'
      WHEN 'store_pages' THEN 'Page de la boutique ' || lower(TG_OP) || ' : ' || COALESCE(to_jsonb(r) ->> 'title', '')
      ELSE 'Design modifié' END;
  END IF;

  INSERT INTO public.activity_log (store_id, team_member_id, user_name, action, entity_type, entity_id, details, created_at)
  VALUES (v_store, v_member, COALESCE(v_actor, 'Propriétaire'), v_action, v_type, to_jsonb(r) ->> 'id', v_details, now());
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL; -- logging must never block a save
END $$;

DROP TRIGGER IF EXISTS trg_team_activity_products ON public.products;
CREATE TRIGGER trg_team_activity_products AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._team_activity_log('product');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['store_theme', 'store_theme_instances', 'store_pages'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_team_activity_design ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_team_activity_design AFTER INSERT OR UPDATE OR DELETE ON public.%I
        FOR EACH ROW EXECUTE FUNCTION public._team_activity_log(%L)', t, 'design');
    END IF;
  END LOOP;
END $$;

COMMIT;
