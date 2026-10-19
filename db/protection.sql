-- Shop protection: remember the buyer's IP on each order so per-IP order limits work.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS client_ip text;
CREATE INDEX IF NOT EXISTS orders_store_client_ip_idx ON public.orders (store_id, client_ip, created_at DESC) WHERE client_ip IS NOT NULL;
