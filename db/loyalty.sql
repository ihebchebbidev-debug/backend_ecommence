-- Shop loyalty; order delivery atomically awards points once.
BEGIN;
CREATE TABLE IF NOT EXISTS public.store_loyalty_settings (
  store_id uuid PRIMARY KEY REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  points_per_unit numeric NOT NULL DEFAULT 1 CHECK (points_per_unit >= 0 AND points_per_unit <= 100),
  reward_points integer NOT NULL DEFAULT 100 CHECK (reward_points BETWEEN 1 AND 1000000),
  reward_type text NOT NULL DEFAULT 'fixed' CHECK (reward_type IN ('fixed','percentage')),
  reward_value numeric NOT NULL DEFAULT 10 CHECK (reward_value > 0),
  enabled_at timestamptz,
  silver_points integer NOT NULL DEFAULT 500 CHECK (silver_points > 0),
  gold_points integer NOT NULL DEFAULT 1500 CHECK (gold_points > silver_points),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.store_loyalty_accounts (
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text NOT NULL DEFAULT '',
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  lifetime_points integer NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, phone)
);
-- One earn row per order, so a status flip-flop never awards twice.
CREATE TABLE IF NOT EXISTS public.store_loyalty_ledger (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.platform_stores(id) ON DELETE CASCADE,
  phone text NOT NULL,
  order_id uuid,
  points integer NOT NULL,
  reason text NOT NULL,
  coupon_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_loyalty_ledger_order ON public.store_loyalty_ledger(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_loyalty_ledger_phone ON public.store_loyalty_ledger(store_id, phone, created_at DESC);


-- These are RPC-only tables. No browser role can modify balances directly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT ALL ON public.store_loyalty_settings, public.store_loyalty_accounts, public.store_loyalty_ledger TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE public.store_loyalty_ledger_id_seq TO service_role;
  END IF;
END $$;
ALTER TABLE public.store_loyalty_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_loyalty_ledger ENABLE ROW LEVEL SECURITY;

-- Award within the delivery transaction; no transient status can be missed by a polling worker.
CREATE OR REPLACE FUNCTION public.award_order_loyalty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s public.store_loyalty_settings%ROWTYPE; digits text; pts integer; inserted bigint;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.status IN ('cancelled','returned','rejected')
    OR NOT (coalesce(NEW.status,'')='delivered' OR coalesce(NEW.delivery_status,'')='delivered') THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.store_loyalty_settings WHERE store_id=NEW.store_id AND enabled FOR SHARE;
  IF NOT FOUND OR s.enabled_at IS NULL OR NEW.created_at < s.enabled_at THEN RETURN NEW; END IF;
  IF NEW.client_phone IS NULL OR length(NEW.client_phone)>32 OR NEW.client_phone !~ '^[0-9[:space:]()+.-]+$' THEN RETURN NEW; END IF;
  digits := regexp_replace(NEW.client_phone,'\D','','g');
  digits := regexp_replace(digits,'^00','');
  IF length(digits)=8 THEN digits := '216'||digits; END IF;
  IF digits !~ '^[1-9][0-9]{7,14}$' THEN RETURN NEW; END IF;
  pts := least(2147483647, greatest(0,floor(coalesce(NEW.amount,0)*s.points_per_unit)))::int;
  IF pts=0 THEN RETURN NEW; END IF;
  INSERT INTO public.store_loyalty_ledger(store_id,phone,order_id,points,reason)
    VALUES (NEW.store_id,digits,NEW.id,pts,'order_delivered') ON CONFLICT DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NOT NULL THEN
    INSERT INTO public.store_loyalty_accounts AS a(store_id,phone,name,points,lifetime_points)
      VALUES (NEW.store_id,digits,coalesce(NEW.client_name,''),pts,pts)
    ON CONFLICT (store_id,phone) DO UPDATE SET points=a.points+EXCLUDED.points,
      lifetime_points=a.lifetime_points+EXCLUDED.lifetime_points, updated_at=now(),
      name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE a.name END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_loyalty_award ON public.orders;
CREATE TRIGGER order_loyalty_award AFTER INSERT OR UPDATE OF status,delivery_status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.award_order_loyalty();
COMMIT;
