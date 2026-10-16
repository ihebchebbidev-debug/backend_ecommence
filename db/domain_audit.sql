-- Persistent domain events share the existing protected admin audit store.
BEGIN;
CREATE INDEX IF NOT EXISTS admin_domain_audit_time ON public.admin_audit_logs(created_at DESC, id DESC)
  WHERE action LIKE 'domain_%';

CREATE OR REPLACE FUNCTION public.audit_domain_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor uuid := nullif(current_setting('app.domain_actor', true), '')::uuid;
BEGIN
  IF TG_TABLE_NAME = 'store_domain_requests' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.admin_audit_logs(action, performed_by, target_store_id, details)
      VALUES ('domain_connection_created', coalesce(actor, NEW.requested_by), NEW.store_id,
        jsonb_build_object('request_id', NEW.id, 'domain', NEW.domain, 'status', NEW.status,
          'expected_proof', 'e-commence-verify=' || NEW.id::text));
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO public.admin_audit_logs(action, performed_by, target_store_id, details)
      VALUES ('domain_status_changed', actor, NEW.store_id,
        jsonb_build_object('request_id', NEW.id, 'domain', NEW.domain, 'before', OLD.status, 'after', NEW.status));
    END IF;
  ELSIF NEW.store_domain IS DISTINCT FROM OLD.store_domain THEN
    INSERT INTO public.admin_audit_logs(action, performed_by, target_store_id, details)
    VALUES ('domain_shop_link_changed', actor, NEW.id,
      jsonb_build_object('domain', coalesce(NEW.store_domain, OLD.store_domain), 'before', OLD.store_domain,
        'after', NEW.store_domain, 'store_name', NEW.store_name, 'slug', NEW.slug));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS domain_request_audit ON public.store_domain_requests;
CREATE TRIGGER domain_request_audit AFTER INSERT OR UPDATE ON public.store_domain_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_domain_mutation();
DROP TRIGGER IF EXISTS domain_shop_link_audit ON public.platform_stores;
CREATE TRIGGER domain_shop_link_audit AFTER UPDATE OF store_domain ON public.platform_stores
  FOR EACH ROW EXECUTE FUNCTION public.audit_domain_mutation();

CREATE OR REPLACE FUNCTION public.protect_domain_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action LIKE 'domain_%' THEN
    RAISE EXCEPTION 'Domain audit history is append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.action LIKE 'domain_%' THEN RAISE EXCEPTION 'Domain audit history is append-only'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_domain_audit ON public.admin_audit_logs;
CREATE TRIGGER protect_domain_audit BEFORE UPDATE OR DELETE ON public.admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.protect_domain_audit();
COMMIT;