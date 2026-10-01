-- Seed plan limits. The live database had an empty plan_limits table, so the
-- seller app could not read any quota. Run once:  psql "$DATABASE_URL" -f db/seed_plan_limits.sql
-- Adjust the numbers to the commercial offer before running.

INSERT INTO public.plan_limits
  (plan, max_stores, max_products, max_orders_per_month, max_team_members, max_coupons, max_warehouses,
   has_cod, has_order_confirmation, has_basic_crm, has_delivery_integration, has_pixels, has_languages, has_reviews,
   has_bundles, has_upsell, has_upsell_crosssell, has_coupons, has_sales_pages, has_landing_pages, has_confirmation_agents,
   has_advanced_crm, can_advanced_analytics, has_automation, has_custom_domain, can_custom_domain, can_export_data,
   has_twilio, has_premium_templates, has_priority_support, has_api, can_api_access, has_webhooks, per_order_fee)
SELECT * FROM (VALUES
  ('starter',       1,  100,  NULL::int, 1,  5,    1,    true, true, true, true, true, true, true,
   false, false, false, true,  false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, 0.5),
  ('pro',           2,  NULL, NULL,      5,  NULL, 2,    true, true, true, true, true, true, true,
   true,  true,  true,  true,  true,  true,  true,  true,  true,  false, true,  true,  true,  true,  true,  false, false, false, false, 0),
  ('business',      5,  NULL, NULL,      20, NULL, 5,    true, true, true, true, true, true, true,
   true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  0),
  ('business_plus', NULL, NULL, NULL,    NULL, NULL, NULL, true, true, true, true, true, true, true,
   true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  0)
) AS v
WHERE NOT EXISTS (SELECT 1 FROM public.plan_limits pl WHERE pl.plan = v.column1);
