-- Refuse to delete a theme family that any shop still uses, whoever sends the delete.
CREATE OR REPLACE FUNCTION public.guard_theme_definition_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE in_use integer;
BEGIN
  SELECT count(*) INTO in_use FROM public.store_theme_instances WHERE theme_definition_id = OLD.id;
  IF in_use > 0 THEN
    RAISE EXCEPTION 'THEME_IN_USE: % shop(s) use this theme family', in_use USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS theme_definitions_guard_delete ON public.theme_definitions;
CREATE TRIGGER theme_definitions_guard_delete
  BEFORE DELETE ON public.theme_definitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_theme_definition_delete();
