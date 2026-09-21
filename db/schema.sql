-- =====================================================================
-- nodejs_backend/db/schema.sql
-- Complete PostgreSQL schema: all 70 public tables of the Supabase backend.
-- Generated from src/integrations/supabase/types.ts (authoritative column
-- list + nullability + foreign keys) merged with documented defaults from
-- complete_supabase_api_spec.md.
--
-- Plain PostgreSQL: no Supabase extensions, no RLS, no auth schema needed.
-- Run with:  psql "$DATABASE_URL" -f schema.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

BEGIN;

-- ---------------------------------------------------------------------
-- activity_log (8 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_log (
  "action"                           text NOT NULL,
  "created_at"                       timestamptz,
  "details"                          text,
  "entity_id"                        text,
  "entity_type"                      text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_id"                         uuid,
  "user_name"                        text,
  CONSTRAINT activity_log_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- admin_audit_logs (7 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  "action"                           text NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "details"                          jsonb DEFAULT '{}'::jsonb NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "performed_by"                     uuid,
  "target_store_id"                  uuid,
  "target_user_id"                   uuid,
  CONSTRAINT admin_audit_logs_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- admin_roles (4 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_roles (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "email"                            text,
  "role"                             text DEFAULT '' NOT NULL,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT admin_roles_pkey PRIMARY KEY ("user_id")
);

-- ---------------------------------------------------------------------
-- agent_sessions (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_sessions (
  "created_at"                       timestamptz,
  "expires_at"                       timestamptz NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "member_name"                      text NOT NULL,
  "member_role"                      text,
  "permissions"                      jsonb,
  "store_id"                         uuid,
  "store_user_id"                    uuid,
  "team_member_id"                   uuid NOT NULL,
  CONSTRAINT agent_sessions_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- audit_logs (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  "action"                           text NOT NULL,
  "admin_email"                      text,
  "admin_id"                         text NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "entity_id"                        text,
  "entity_type"                      text NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "ip_address"                       text,
  "metadata"                         jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT audit_logs_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- campaigns (12 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaigns (
  "budget"                           numeric,
  "created_at"                       timestamptz,
  "end_date"                         date,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "leads"                            numeric,
  "name"                             text NOT NULL,
  "platform"                         text,
  "roas"                             numeric,
  "spend"                            numeric,
  "start_date"                       date,
  "status"                           text,
  "store_id"                         uuid,
  CONSTRAINT campaigns_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- carriers (8 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.carriers (
  "avg_days"                         integer,
  "cost"                             numeric,
  "created_at"                       timestamptz,
  "delivery_rate"                    numeric,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "name"                             text NOT NULL,
  "status"                           text,
  "store_id"                         uuid,
  CONSTRAINT carriers_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- categories (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.categories (
  "color"                            text,
  "created_at"                       timestamptz,
  "description"                      text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "image_url"                        text,
  "name"                             text NOT NULL,
  "parent_id"                        uuid,
  "slug"                             text NOT NULL,
  "store_id"                         uuid,
  CONSTRAINT categories_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- checkout_settings (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.checkout_settings (
  "checkout_type"                    text DEFAULT '' NOT NULL,
  "created_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "position"                         text DEFAULT '' NOT NULL,
  "require_address"                  boolean DEFAULT false NOT NULL,
  "require_email"                    boolean DEFAULT false NOT NULL,
  "require_notes"                    boolean DEFAULT false NOT NULL,
  "require_phone"                    boolean DEFAULT false NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz,
  CONSTRAINT checkout_settings_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- clients (11 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clients (
  "city"                             text,
  "created_at"                       timestamptz,
  "email"                            text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "name"                             text NOT NULL,
  "note"                             text,
  "phone"                            text,
  "region"                           text,
  "status"                           text,
  "store_id"                         uuid,
  "updated_at"                       timestamptz,
  CONSTRAINT clients_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- coupons (11 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coupons (
  "active"                           boolean DEFAULT false NOT NULL,
  "code"                             text NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "expires_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "max_uses"                         integer,
  "min_order_amount"                 numeric,
  "store_id"                         uuid NOT NULL,
  "type"                             text DEFAULT '' NOT NULL,
  "used_count"                       integer DEFAULT 0 NOT NULL,
  "value"                            numeric DEFAULT 0 NOT NULL,
  CONSTRAINT coupons_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- crm_calls (12 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_calls (
  "agent_name"                       text,
  "attempt"                          numeric,
  "call_time"                        time,
  "created_at"                       timestamptz,
  "customer_name"                    text,
  "duration"                         text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "notes"                            text,
  "order_number"                     text,
  "phone"                            text,
  "status"                           text,
  "store_id"                         uuid,
  CONSTRAINT crm_calls_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- currency_rates (8 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.currency_rates (
  "base_currency"                    text DEFAULT '' NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "is_active"                        boolean DEFAULT false NOT NULL,
  "rate"                             numeric NOT NULL,
  "source"                           text DEFAULT '' NOT NULL,
  "target_currency"                  text DEFAULT '' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT currency_rates_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- delivery_integration_secrets (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_integration_secrets (
  "created_at"                       timestamptz,
  "credentials_ciphertext"           text NOT NULL,
  "credentials_iv"                   text NOT NULL,
  "credentials_tag"                  text,
  "encryption_version"               text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "integration_id"                   uuid NOT NULL,
  "provider_id"                      uuid NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz,
  CONSTRAINT delivery_integration_secrets_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- delivery_provider_localities (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_provider_localities (
  "created_at"                       timestamptz,
  "delegation_name"                  text,
  "governorate_name"                 text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "locality_id"                      numeric NOT NULL,
  "locality_name"                    text,
  "provider_code"                    text NOT NULL,
  "raw_payload"                      jsonb,
  "updated_at"                       timestamptz,
  CONSTRAINT delivery_provider_localities_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- delivery_providers (40 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_providers (
  "auth_header_name"                 text,
  "auth_type"                        text,
  "base_url"                         text,
  "bulk_create_endpoint"             text,
  "cancel_shipment_endpoint"         text,
  "category"                         text,
  "code"                             text NOT NULL,
  "country"                          text,
  "create_shipment_endpoint"         text,
  "create_shipment_payload_template" jsonb,
  "created_at"                       timestamptz,
  "created_by"                       uuid,
  "credentials_schema"               jsonb,
  "description"                      text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "integration_mode"                 text,
  "is_active"                        boolean,
  "is_visible_to_stores"             boolean,
  "label_endpoint"                   text,
  "localities_endpoint"              text,
  "logo_url"                         text,
  "name"                             text NOT NULL,
  "pickup_endpoint"                  text,
  "print_pickup_endpoint"            text,
  "response_mapping"                 jsonb,
  "sender_schema"                    jsonb,
  "settings_schema"                  jsonb,
  "sort_order"                       integer,
  "status_mapping"                   jsonb,
  "supports_cod"                     boolean,
  "supports_label"                   boolean,
  "supports_open_package"            boolean,
  "supports_return"                  boolean,
  "supports_tracking"                boolean,
  "supports_webhook"                 boolean,
  "track_shipment_endpoint"          text,
  "tracking_payload_template"        jsonb,
  "updated_at"                       timestamptz,
  "updated_by"                       uuid,
  "webhook_endpoint_hint"            text,
  CONSTRAINT delivery_providers_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- delivery_shipments (15 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_shipments (
  "created_at"                       timestamptz,
  "external_shipment_id"             text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "integration_id"                   uuid,
  "label_url"                        text,
  "order_id"                         uuid NOT NULL,
  "provider_code"                    text NOT NULL,
  "provider_id"                      uuid,
  "provider_response"                jsonb,
  "shipment_payload"                 jsonb,
  "status"                           text,
  "store_id"                         uuid NOT NULL,
  "tracking_number"                  text,
  "tracking_url"                     text,
  "updated_at"                       timestamptz,
  CONSTRAINT delivery_shipments_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- delivery_tracking_events (8 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_tracking_events (
  "created_at"                       timestamptz,
  "description"                      text,
  "event_type"                       text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "raw_data"                         jsonb,
  "shipment_id"                      uuid NOT NULL,
  "status"                           text,
  "store_id"                         uuid NOT NULL,
  CONSTRAINT delivery_tracking_events_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- finance_fixed_items (11 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_fixed_items (
  "active"                           boolean DEFAULT false NOT NULL,
  "amount"                           numeric DEFAULT 0 NOT NULL,
  "category"                         text DEFAULT '' NOT NULL,
  "created_at"                       timestamptz,
  "frequency"                        text DEFAULT '' NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "label"                            text NOT NULL,
  "notes"                            text,
  "store_id"                         uuid,
  "type"                             text DEFAULT '' NOT NULL,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT finance_fixed_items_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- invoices (14 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoices (
  "amount_tnd"                       numeric,
  "amount_usd"                       numeric NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "display_currency"                 text DEFAULT '' NOT NULL,
  "due_date"                         date,
  "exchange_rate"                    numeric,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "invoice_number"                   text,
  "paid_at"                          timestamptz,
  "payment_currency"                 text DEFAULT '' NOT NULL,
  "payment_id"                       uuid,
  "status"                           text DEFAULT '' NOT NULL,
  "store_id"                         uuid NOT NULL,
  "subscription_id"                  uuid,
  CONSTRAINT invoices_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- ip_blacklist (5 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ip_blacklist (
  "blocked_orders"                   numeric,
  "created_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "ip_address"                       text NOT NULL,
  "reason"                           text,
  CONSTRAINT ip_blacklist_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- onboarding_answers (5 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_answers (
  "answer"                           text NOT NULL,
  "created_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "question_key"                     text NOT NULL,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT onboarding_answers_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- onboarding_progress (6 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  "completed"                        boolean DEFAULT false NOT NULL,
  "current_step"                     text DEFAULT '' NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_id"                         uuid,
  "updated_at"                       timestamptz,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT onboarding_progress_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- orders (42 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
  "address"                          text,
  "agent_id"                         uuid,
  "agent_name"                       text,
  "amount"                           numeric DEFAULT 0 NOT NULL,
  "bundle_id"                        uuid,
  "bundle_label"                     text,
  "bundle_name"                      text,
  "bundle_price"                     numeric,
  "bundle_quantity"                  integer,
  "callback_scheduled_at"            timestamptz,
  "city"                             text,
  "client_id"                        uuid,
  "client_name"                      text,
  "client_phone"                     text,
  "client_phone2"                    text,
  "confirmation_notes"               text,
  "confirmation_status"              text,
  "confirmed_at"                     timestamptz,
  "created_at"                       timestamptz,
  "currency"                         text DEFAULT 'TND' NOT NULL,
  "deleted_at"                       timestamptz,
  "deleted_by"                       uuid,
  "delivery_status"                  text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "locality_id"                      numeric,
  "notes"                            text,
  "order_billing_status"             text DEFAULT 'pending' NOT NULL,
  "order_fee_amount_tnd"             numeric,
  "order_fee_amount_usd"             numeric DEFAULT 0 NOT NULL,
  "order_fee_charged_at"             timestamptz,
  "order_number"                     text NOT NULL,
  "payment_provider"                 text,
  "payment_ref"                      text,
  "payment_status"                   text DEFAULT 'unpaid' NOT NULL,
  "product_id"                       uuid,
  "product_name"                     text,
  "quantity"                         integer,
  "region"                           text,
  "status"                           text,
  "store_id"                         uuid NOT NULL,
  "tracking_number"                  text,
  "updated_at"                       timestamptz,
  CONSTRAINT orders_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- otp_rate_limit_resets (6 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.otp_rate_limit_resets (
  "actor_email"                      text NOT NULL,
  "actor_id"                         text NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "rows_deleted"                     numeric DEFAULT 0 NOT NULL,
  "target_phone"                     text NOT NULL,
  CONSTRAINT otp_rate_limit_resets_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- otp_verification_logs (12 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.otp_verification_logs (
  "country_code"                     text,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "error_code"                       text,
  "error_msg"                        text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "ip_address"                       text,
  "method"                           text,
  "phone"                            text NOT NULL,
  "provider"                         text,
  "status"                           text DEFAULT '' NOT NULL,
  "twilio_status"                    text,
  "user_id"                          uuid,
  CONSTRAINT otp_verification_logs_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- payment_gateway_settings (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_gateway_settings (
  "api_key"                          text,
  "connection_status"                text DEFAULT '' NOT NULL,
  "enabled"                          boolean DEFAULT false NOT NULL,
  "environment"                      text DEFAULT '' NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "last_tested_at"                   timestamptz,
  "provider"                         text DEFAULT '' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "updated_by"                       uuid,
  "wallet_id"                        text,
  CONSTRAINT payment_gateway_settings_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- payments (18 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
  "amount_tnd"                       numeric NOT NULL,
  "amount_usd"                       numeric NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "display_currency"                 text DEFAULT '' NOT NULL,
  "exchange_rate"                    numeric NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "metadata"                         jsonb DEFAULT '{}'::jsonb NOT NULL,
  "paid_at"                          timestamptz,
  "payment_currency"                 text DEFAULT '' NOT NULL,
  "plan_code"                        text,
  "provider"                         text DEFAULT '' NOT NULL,
  "provider_payment_id"              text,
  "provider_payment_url"             text,
  "purpose"                          text DEFAULT '' NOT NULL,
  "status"                           text DEFAULT '' NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "user_id"                          uuid,
  CONSTRAINT payments_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- phone_blacklist (5 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_blacklist (
  "client_name"                      text,
  "created_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "phone"                            text NOT NULL,
  "reason"                           text,
  CONSTRAINT phone_blacklist_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- phone_otp_codes (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_otp_codes (
  "channel"                          text DEFAULT '' NOT NULL,
  "code"                             text NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "expires_at"                       timestamptz DEFAULT now() NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "phone"                            text NOT NULL,
  "resend_count"                     integer DEFAULT 0 NOT NULL,
  "used"                             boolean DEFAULT false NOT NULL,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT phone_otp_codes_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- phone_settings_audit (7 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_settings_audit (
  "admin_email"                      text,
  "admin_id"                         text,
  "changed_at"                       timestamptz DEFAULT now() NOT NULL,
  "field_name"                       text NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "new_value"                        text,
  "old_value"                        text,
  CONSTRAINT phone_settings_audit_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- phone_verification_settings (26 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_verification_settings (
  "access_token"                     text,
  "account_sid"                      text,
  "api_key"                          text,
  "auth_token"                       text,
  "business_account_id"              text,
  "connection_status"                text DEFAULT '' NOT NULL,
  "default_method"                   text DEFAULT '' NOT NULL,
  "enabled"                          boolean DEFAULT false NOT NULL,
  "force_verification"               boolean DEFAULT false NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "last_tested_at"                   timestamptz,
  "phone_number_id"                  text,
  "provider"                         text DEFAULT '' NOT NULL,
  "sms_enabled"                      boolean DEFAULT false NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "updated_by"                       uuid,
  "verify_service_sid"               text,
  "whatsapp_enabled"                 boolean DEFAULT false NOT NULL,
  "whatsapp_registered_at"           timestamptz,
  "whatsapp_registration_error"      text,
  "whatsapp_registration_status"     text DEFAULT '' NOT NULL,
  "whatsapp_two_step_pin"            text,
  "whatsapp_webhook_last_event_at"   timestamptz,
  "whatsapp_webhook_last_verified_at" timestamptz,
  "whatsapp_webhook_status"          text DEFAULT '' NOT NULL,
  "whatsapp_webhook_verify_token"    text,
  CONSTRAINT phone_verification_settings_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- plan_limits (53 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plan_limits (
  "can_advanced_analytics"           boolean DEFAULT false NOT NULL,
  "can_api_access"                   boolean DEFAULT false NOT NULL,
  "can_custom_domain"                boolean DEFAULT false NOT NULL,
  "can_export_data"                  boolean DEFAULT false NOT NULL,
  "can_multi_currency"               boolean DEFAULT false NOT NULL,
  "has_ab_testing"                   boolean DEFAULT false NOT NULL,
  "has_advanced_crm"                 boolean DEFAULT false NOT NULL,
  "has_advanced_roles"               boolean DEFAULT false NOT NULL,
  "has_advanced_seo"                 boolean DEFAULT false NOT NULL,
  "has_advanced_stock"               boolean DEFAULT false NOT NULL,
  "has_affiliate"                    boolean DEFAULT false NOT NULL,
  "has_api"                          boolean DEFAULT false NOT NULL,
  "has_auto_cart_recovery"           boolean DEFAULT false NOT NULL,
  "has_automation"                   boolean DEFAULT false NOT NULL,
  "has_basic_crm"                    boolean DEFAULT false NOT NULL,
  "has_bundles"                      boolean DEFAULT false NOT NULL,
  "has_cod"                          boolean DEFAULT false NOT NULL,
  "has_confirmation_agents"          boolean DEFAULT false NOT NULL,
  "has_coupons"                      boolean DEFAULT false NOT NULL,
  "has_custom_dev"                   boolean DEFAULT false NOT NULL,
  "has_custom_domain"                boolean DEFAULT false NOT NULL,
  "has_delivery_integration"         boolean DEFAULT false NOT NULL,
  "has_landing_pages"                boolean DEFAULT false NOT NULL,
  "has_languages"                    boolean DEFAULT false NOT NULL,
  "has_marketing_service"            boolean DEFAULT false NOT NULL,
  "has_multi_depot"                  boolean DEFAULT false NOT NULL,
  "has_multi_warehouse"              boolean DEFAULT false NOT NULL,
  "has_online_payment"               boolean DEFAULT false NOT NULL,
  "has_order_confirmation"           boolean DEFAULT false NOT NULL,
  "has_pixels"                       boolean DEFAULT false NOT NULL,
  "has_premium_templates"            boolean DEFAULT false NOT NULL,
  "has_priority_support"             boolean DEFAULT false NOT NULL,
  "has_reviews"                      boolean DEFAULT false NOT NULL,
  "has_sales_pages"                  boolean DEFAULT false NOT NULL,
  "has_sla"                          boolean DEFAULT false NOT NULL,
  "has_team_ranking"                 boolean DEFAULT false NOT NULL,
  "has_trust_score"                  boolean DEFAULT false NOT NULL,
  "has_twilio"                       boolean DEFAULT false NOT NULL,
  "has_upsell"                       boolean DEFAULT false NOT NULL,
  "has_upsell_crosssell"             boolean DEFAULT false NOT NULL,
  "has_webhooks"                     boolean DEFAULT false NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "max_coupons"                      integer,
  "max_orders_per_month"             integer,
  "max_products"                     integer,
  "max_stores"                       integer,
  "max_team_members"                 integer,
  "max_warehouses"                   integer,
  "per_order_fee"                    numeric DEFAULT 0 NOT NULL,
  "plan"                             text NOT NULL,
  "plan_id"                          uuid,
  "trial_balance_usd"                numeric DEFAULT 0 NOT NULL,
  "trial_days"                       integer DEFAULT 0 NOT NULL,
  CONSTRAINT plan_limits_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- plans (18 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plans (
  "annual_discount_pct"              numeric DEFAULT 0 NOT NULL,
  "billing_type"                     text DEFAULT 'monthly' NOT NULL,
  "code"                             text NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "currency"                         text DEFAULT 'USD' NOT NULL,
  "currency_display"                 text DEFAULT 'USD' NOT NULL,
  "currency_payment"                 text DEFAULT 'USD' NOT NULL,
  "description"                      text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "is_active"                        boolean DEFAULT true NOT NULL,
  "name"                             text NOT NULL,
  "per_confirmed_order_fee_usd"      numeric DEFAULT 0 NOT NULL,
  "per_order_fee_tnd"                numeric DEFAULT 0 NOT NULL,
  "price"                            numeric DEFAULT 0 NOT NULL,
  "price_tnd"                        numeric,
  "price_usd"                        numeric DEFAULT 0 NOT NULL,
  "tier"                             numeric,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT plans_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- platform_settings (3 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_settings (
  "key"                              text DEFAULT '' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "value"                            text,
  CONSTRAINT platform_settings_pkey PRIMARY KEY ("key")
);

-- ---------------------------------------------------------------------
-- platform_stores (25 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_stores (
  "auto_detect_country"              boolean DEFAULT false NOT NULL,
  "auto_detect_language"             boolean DEFAULT false NOT NULL,
  "country"                          text DEFAULT 'TN' NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "currency"                         text DEFAULT 'TND' NOT NULL,
  "default_language"                 text DEFAULT 'ar' NOT NULL,
  "deleted_at"                       timestamptz,
  "enabled_languages"                text[] DEFAULT ARRAY['ar']::text[] NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "internal_notes"                   text,
  "last_activity_at"                 timestamptz,
  "logo_url"                         text,
  "plan_id"                          uuid,
  "quarantine_reason"                text,
  "remediation_action"               text,
  "settings"                         jsonb DEFAULT '{}'::jsonb NOT NULL,
  "slug"                             text NOT NULL,
  "status"                           text DEFAULT 'active' NOT NULL,
  "store_color"                      text,
  "store_domain"                     text,
  "store_name"                       text,
  "subscription_plan"                text,
  "total_revenue"                    numeric,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "user_id"                          uuid,
  CONSTRAINT platform_stores_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- product_bundles (15 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_bundles (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "delivery_fee"                     numeric DEFAULT 0 NOT NULL,
  "discount_badge"                   text,
  "discount_color"                   text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "image_url"                        text,
  "is_default"                       boolean DEFAULT false NOT NULL,
  "label"                            text,
  "name"                             text,
  "price"                            numeric DEFAULT 0 NOT NULL,
  "price_before_discount"            numeric DEFAULT 0 NOT NULL,
  "product_id"                       uuid NOT NULL,
  "quantity"                         integer DEFAULT 1 NOT NULL,
  "sort_order"                       integer DEFAULT 0 NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_bundles_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- product_options (8 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_options (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "name"                             text NOT NULL,
  "product_id"                       uuid NOT NULL,
  "sort_order"                       integer DEFAULT 0 NOT NULL,
  "type"                             text DEFAULT 'select' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "values"                           jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT product_options_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- product_reviews (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_reviews (
  "comment"                          text,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "customer_name"                    text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "image_url"                        text,
  "product_id"                       uuid NOT NULL,
  "rating"                           numeric DEFAULT 5 NOT NULL,
  "sort_order"                       integer DEFAULT 0 NOT NULL,
  "status"                           text DEFAULT 'published' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_reviews_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- products (28 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
  "category_id"                      uuid,
  "cost"                             numeric,
  "created_at"                       timestamptz,
  "delivery_cost"                    numeric DEFAULT 0 NOT NULL,
  "delivery_fee"                     numeric DEFAULT 0 NOT NULL,
  "description"                      text,
  "description_ar"                   text,
  "description_fr"                   text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "image_url"                        text,
  "name"                             text NOT NULL,
  "name_ar"                          text,
  "name_fr"                          text,
  "price"                            numeric DEFAULT 0 NOT NULL,
  "rating"                           numeric,
  "seo_description_ar"               text,
  "seo_description_fr"               text,
  "seo_title_ar"                     text,
  "seo_title_fr"                     text,
  "short_description"                text,
  "short_description_ar"             text,
  "short_description_fr"             text,
  "sku"                              text,
  "sold"                             numeric,
  "status"                           text,
  "stock"                            integer,
  "store_id"                         uuid,
  "updated_at"                       timestamptz,
  CONSTRAINT products_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- profiles (13 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  "avatar_url"                       text,
  "country"                          text,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "deleted_at"                       timestamptz,
  "email"                            text,
  "full_name"                        text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "otp_channel"                      text DEFAULT 'sms' NOT NULL,
  "phone"                            text,
  "phone_verified"                   boolean DEFAULT false NOT NULL,
  "phone_verified_at"                timestamptz,
  "status"                           text DEFAULT 'active' NOT NULL,
  "suspended_at"                     timestamptz,
  CONSTRAINT profiles_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- shipments (13 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shipments (
  "carrier_id"                       uuid,
  "carrier_name"                     text,
  "client_name"                      text,
  "created_at"                       timestamptz,
  "delivered_at"                     timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "order_id"                         uuid,
  "order_number"                     text,
  "region"                           text,
  "shipped_at"                       timestamptz,
  "status"                           text,
  "store_id"                         uuid,
  "tracking_number"                  text,
  CONSTRAINT shipments_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_banners (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_banners (
  "active"                           boolean DEFAULT false NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "image_url"                        text,
  "link_url"                         text,
  "sort_order"                       integer DEFAULT 0 NOT NULL,
  "store_id"                         uuid,
  "subtitle"                         text,
  "title"                            text,
  CONSTRAINT store_banners_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_custom_fields (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_custom_fields (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "field_label"                      text NOT NULL,
  "field_name"                       text NOT NULL,
  "field_type"                       text DEFAULT '' NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "options"                          text[],
  "required"                         boolean DEFAULT false NOT NULL,
  "sort_order"                       integer DEFAULT 0 NOT NULL,
  "store_id"                         uuid,
  CONSTRAINT store_custom_fields_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_custom_limits (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_custom_limits (
  "force_phone_verification"         boolean DEFAULT false NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "max_orders_per_month"             integer,
  "max_products"                     integer,
  "max_stores"                       integer,
  "max_team_members"                 integer,
  "notes"                            text,
  "set_at"                           timestamptz DEFAULT now() NOT NULL,
  "set_by"                           text,
  "store_id"                         uuid NOT NULL,
  CONSTRAINT store_custom_limits_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_delivery_integrations (23 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_delivery_integrations (
  "created_at"                       timestamptz,
  "credentials_encrypted"            jsonb,
  "default_provider"                 boolean,
  "delivery_cost_tnd"                numeric,
  "enabled"                          boolean,
  "has_credentials"                  boolean,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "label_enabled"                    boolean,
  "last_error"                       text,
  "last_test_at"                     timestamptz,
  "localities_last_synced_at"        timestamptz,
  "masked_credentials"               jsonb,
  "metadata"                         jsonb,
  "provider_code"                    text NOT NULL,
  "provider_id"                      uuid NOT NULL,
  "provider_settings"                jsonb,
  "return_cost_tnd"                  numeric,
  "sender_config"                    jsonb,
  "status"                           text,
  "store_id"                         uuid NOT NULL,
  "test_mode"                        boolean,
  "tracking_enabled"                 boolean,
  "updated_at"                       timestamptz,
  CONSTRAINT store_delivery_integrations_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_delivery_settings (7 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_delivery_settings (
  "auto_send_after_confirmation"     boolean DEFAULT false NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "default_provider_id"              uuid,
  "dispatch_mode"                    text DEFAULT 'manual' NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_delivery_settings_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_feature_overrides (7 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_feature_overrides (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "feature_key"                      text NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "is_enabled"                       boolean DEFAULT false NOT NULL,
  "reason"                           text,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_feature_overrides_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_members (11 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_members (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "deleted_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "invited_by"                       text,
  "invited_email"                    text,
  "permissions"                      jsonb DEFAULT '{}'::jsonb NOT NULL,
  "role"                             text DEFAULT '' NOT NULL,
  "status"                           text DEFAULT '' NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT store_members_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_onboarding_answers (16 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_onboarding_answers (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "ecommerce_experience"             text,
  "has_confirmation_team"            boolean,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "main_objective"                   text,
  "monthly_orders_range"             text,
  "needs_marketing_support"          boolean,
  "needs_online_payment"             boolean,
  "needs_whatsapp_or_sms_otp"        boolean,
  "products_range"                   text,
  "recommended_plan"                 text,
  "sector"                           text,
  "selected_plan"                    text,
  "store_id"                         uuid NOT NULL,
  "team_size"                        text,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_onboarding_answers_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_order_seq (2 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_order_seq (
  "next_val"                         numeric DEFAULT 0 NOT NULL,
  "store_id"                         uuid NOT NULL,
  CONSTRAINT store_order_seq_pkey PRIMARY KEY ("store_id")
);

-- ---------------------------------------------------------------------
-- store_pages (7 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_pages (
  "active"                           boolean DEFAULT false NOT NULL,
  "content"                          text,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "slug"                             text NOT NULL,
  "store_id"                         uuid,
  "title"                            text NOT NULL,
  CONSTRAINT store_pages_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_payment_integrations (11 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_payment_integrations (
  "connection_status"                text DEFAULT '' NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "credentials_encrypted"            text,
  "credentials_iv"                   text,
  "credentials_version"              text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "is_active"                        boolean DEFAULT false NOT NULL,
  "last_tested_at"                   timestamptz,
  "provider"                         text NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_payment_integrations_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_role_permissions (5 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_role_permissions (
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "permissions"                      jsonb DEFAULT '{}'::jsonb NOT NULL,
  "role"                             text NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_role_permissions_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_sales_pages (13 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_sales_pages (
  "content"                          jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "headline"                         text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "name"                             text DEFAULT '' NOT NULL,
  "orders"                           numeric DEFAULT 0 NOT NULL,
  "product_id"                       uuid,
  "slug"                             text NOT NULL,
  "status"                           text DEFAULT '' NOT NULL,
  "store_id"                         uuid NOT NULL,
  "template"                         text DEFAULT '' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "visits"                           numeric DEFAULT 0 NOT NULL,
  CONSTRAINT store_sales_pages_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_settings (5 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_settings (
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "key"                              text NOT NULL,
  "store_id"                         uuid,
  "updated_at"                       timestamptz,
  "value"                            text,
  CONSTRAINT store_settings_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_subscriptions (20 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_subscriptions (
  "billing_cycle"                    text DEFAULT 'monthly' NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "current_period_end"               text,
  "current_period_start"             text,
  "customer_data_locked"             boolean,
  "customer_data_locked_at"          timestamptz,
  "customer_data_locked_reason"      text,
  "expires_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "paid_at"                          timestamptz,
  "plan_id"                          uuid,
  "started_at"                       timestamptz DEFAULT now() NOT NULL,
  "status"                           text DEFAULT 'trialing' NOT NULL,
  "store_id"                         uuid,
  "trial_ends_at"                    timestamptz,
  "trial_order_value_limit_tnd"      integer,
  "trial_order_value_used_tnd"       numeric,
  "trial_status"                     text,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "user_id"                          uuid,
  CONSTRAINT store_subscriptions_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_theme (8 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_theme (
  "created_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "logo_url"                         text,
  "primary_color"                    text DEFAULT '' NOT NULL,
  "secondary_color"                  text DEFAULT '' NOT NULL,
  "store_id"                         uuid NOT NULL,
  "theme_id"                         text DEFAULT '' NOT NULL,
  "updated_at"                       timestamptz,
  CONSTRAINT store_theme_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_theme_instances (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_theme_instances (
  "configuration"                    jsonb,
  "created_at"                       timestamptz,
  "created_by"                       uuid,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "preset_id"                        uuid NOT NULL,
  "published_at"                     timestamptz,
  "status"                           text DEFAULT '' NOT NULL,
  "store_id"                         uuid NOT NULL,
  "theme_definition_id"              uuid NOT NULL,
  "updated_at"                       timestamptz,
  CONSTRAINT store_theme_instances_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_upsell_offers (13 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_upsell_offers (
  "active"                           boolean DEFAULT false NOT NULL,
  "conversions"                      integer DEFAULT 0 NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "discount_percent"                 numeric DEFAULT 0 NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "name"                             text DEFAULT '' NOT NULL,
  "offer_product_id"                 uuid,
  "priority"                         integer DEFAULT 0 NOT NULL,
  "revenue"                          numeric DEFAULT 0 NOT NULL,
  "store_id"                         uuid NOT NULL,
  "trigger_product_id"               uuid,
  "type"                             text DEFAULT '' NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_upsell_offers_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_usage (6 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_usage (
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "month_year"                       text NOT NULL,
  "orders_count"                     integer DEFAULT 0 NOT NULL,
  "products_count"                   integer DEFAULT 0 NOT NULL,
  "store_id"                         uuid NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_usage_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- store_wallets (12 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_wallets (
  "balance_tnd"                      numeric,
  "balance_usd"                      numeric DEFAULT 0 NOT NULL,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "currency_tnd"                     text,
  "display_currency"                 text DEFAULT '' NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "payment_currency"                 text DEFAULT '' NOT NULL,
  "starter_order_fee_tnd"            numeric,
  "store_id"                         uuid NOT NULL,
  "trial_balance_expires_at"         timestamptz,
  "trial_balance_usd"                numeric DEFAULT 0 NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT store_wallets_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- subscription_plans (9 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "features"                         text[] DEFAULT '{}'::text[] NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "is_active"                        boolean DEFAULT false NOT NULL,
  "max_orders"                       integer DEFAULT 0 NOT NULL,
  "max_products"                     integer DEFAULT 0 NOT NULL,
  "name"                             text NOT NULL,
  "price_monthly"                    numeric DEFAULT 0 NOT NULL,
  "price_yearly"                     numeric DEFAULT 0 NOT NULL,
  CONSTRAINT subscription_plans_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- team_members (19 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  "available"                        boolean,
  "avg_call_time"                    time,
  "calls"                            numeric,
  "confirmed"                        numeric,
  "created_at"                       timestamptz,
  "email"                            text,
  "first_name"                       text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "last_name"                        text,
  "name"                             text NOT NULL,
  "online"                           boolean,
  "password_hash"                    text,
  "permissions"                      jsonb,
  "phone"                            text,
  "role"                             text,
  "shift"                            text,
  "status"                           text,
  "store_id"                         uuid,
  "username"                         text,
  CONSTRAINT team_members_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- theme_definitions (13 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.theme_definitions (
  "category"                         text,
  "created_at"                       timestamptz,
  "description"                      text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "is_active"                        boolean,
  "key"                              text NOT NULL,
  "manifest"                         jsonb,
  "name"                             text NOT NULL,
  "preview_desktop_url"              text,
  "preview_mobile_url"               text,
  "sort_order"                       integer,
  "updated_at"                       timestamptz,
  "version"                          text,
  CONSTRAINT theme_definitions_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- theme_presets (12 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.theme_presets (
  "created_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "industry"                         text,
  "is_available"                     boolean,
  "key"                              text NOT NULL,
  "name"                             text NOT NULL,
  "preview_desktop_url"              text,
  "preview_mobile_url"               text,
  "sort_order"                       integer,
  "theme_definition_id"              uuid NOT NULL,
  "tokens"                           jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at"                       timestamptz,
  CONSTRAINT theme_presets_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- transactions (10 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transactions (
  "amount"                           numeric NOT NULL,
  "category"                         text,
  "created_at"                       timestamptz,
  "date"                             date,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "label"                            text NOT NULL,
  "notes"                            text,
  "reference_id"                     text,
  "store_id"                         uuid,
  "type"                             text NOT NULL,
  CONSTRAINT transactions_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- wallet_transactions (18 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  "amount"                           numeric NOT NULL,
  "amount_tnd"                       numeric,
  "amount_usd"                       numeric,
  "created_at"                       timestamptz DEFAULT now() NOT NULL,
  "description"                      text,
  "exchange_rate"                    numeric,
  "expires_at"                       timestamptz,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "metadata"                         jsonb DEFAULT '{}'::jsonb NOT NULL,
  "order_id"                         uuid,
  "payment_id"                       uuid,
  "payment_method"                   text,
  "reference"                        text,
  "status"                           text DEFAULT '' NOT NULL,
  "store_id"                         uuid,
  "type"                             text NOT NULL,
  "user_id"                          uuid NOT NULL,
  "wallet_id"                        uuid,
  CONSTRAINT wallet_transactions_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- wallets (4 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallets (
  "balance"                          numeric DEFAULT 0 NOT NULL,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "updated_at"                       timestamptz DEFAULT now() NOT NULL,
  "user_id"                          uuid NOT NULL,
  CONSTRAINT wallets_pkey PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- whatsapp_webhook_events (4 columns)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_events (
  "event_type"                       text,
  "id"                               uuid DEFAULT gen_random_uuid() NOT NULL,
  "payload"                          jsonb,
  "received_at"                      timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT whatsapp_webhook_events_pkey PRIMARY KEY ("id")
);

-- =====================================================================
-- Foreign keys
-- =====================================================================

DO $$ BEGIN
  ALTER TABLE public.activity_log ADD CONSTRAINT activity_log_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.agent_sessions ADD CONSTRAINT agent_sessions_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.carriers ADD CONSTRAINT carriers_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.categories ADD CONSTRAINT categories_parent_id_fkey
    FOREIGN KEY ("parent_id") REFERENCES public.categories ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.categories ADD CONSTRAINT categories_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.checkout_settings ADD CONSTRAINT checkout_settings_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.clients ADD CONSTRAINT clients_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.coupons ADD CONSTRAINT coupons_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.crm_calls ADD CONSTRAINT crm_calls_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_integration_secrets ADD CONSTRAINT delivery_integration_secrets_integration_id_fkey
    FOREIGN KEY ("integration_id") REFERENCES public.store_delivery_integrations ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_integration_secrets ADD CONSTRAINT delivery_integration_secrets_provider_id_fkey
    FOREIGN KEY ("provider_id") REFERENCES public.delivery_providers ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_integration_secrets ADD CONSTRAINT delivery_integration_secrets_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_shipments ADD CONSTRAINT delivery_shipments_integration_id_fkey
    FOREIGN KEY ("integration_id") REFERENCES public.store_delivery_integrations ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_shipments ADD CONSTRAINT delivery_shipments_order_id_fkey
    FOREIGN KEY ("order_id") REFERENCES public.orders ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_shipments ADD CONSTRAINT delivery_shipments_provider_id_fkey
    FOREIGN KEY ("provider_id") REFERENCES public.delivery_providers ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_shipments ADD CONSTRAINT delivery_shipments_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_tracking_events ADD CONSTRAINT delivery_tracking_events_shipment_id_fkey
    FOREIGN KEY ("shipment_id") REFERENCES public.delivery_shipments ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.delivery_tracking_events ADD CONSTRAINT delivery_tracking_events_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.finance_fixed_items ADD CONSTRAINT finance_fixed_items_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_payment_id_fkey
    FOREIGN KEY ("payment_id") REFERENCES public.payments ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_subscription_id_fkey
    FOREIGN KEY ("subscription_id") REFERENCES public.store_subscriptions ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.onboarding_progress ADD CONSTRAINT onboarding_progress_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_agent_id_fkey
    FOREIGN KEY ("agent_id") REFERENCES public.team_members ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_bundle_id_fkey
    FOREIGN KEY ("bundle_id") REFERENCES public.product_bundles ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_client_id_fkey
    FOREIGN KEY ("client_id") REFERENCES public.clients ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_product_id_fkey
    FOREIGN KEY ("product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.payments ADD CONSTRAINT payments_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.plan_limits ADD CONSTRAINT plan_limits_plan_id_fkey
    FOREIGN KEY ("plan_id") REFERENCES public.plans ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.product_bundles ADD CONSTRAINT product_bundles_product_id_fkey
    FOREIGN KEY ("product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.product_options ADD CONSTRAINT product_options_product_id_fkey
    FOREIGN KEY ("product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_product_id_fkey
    FOREIGN KEY ("product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.products ADD CONSTRAINT products_category_id_fkey
    FOREIGN KEY ("category_id") REFERENCES public.categories ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.products ADD CONSTRAINT products_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.shipments ADD CONSTRAINT shipments_carrier_id_fkey
    FOREIGN KEY ("carrier_id") REFERENCES public.carriers ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.shipments ADD CONSTRAINT shipments_order_id_fkey
    FOREIGN KEY ("order_id") REFERENCES public.orders ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.shipments ADD CONSTRAINT shipments_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_banners ADD CONSTRAINT store_banners_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_custom_fields ADD CONSTRAINT store_custom_fields_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_custom_limits ADD CONSTRAINT store_custom_limits_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_delivery_integrations ADD CONSTRAINT store_delivery_integrations_provider_id_fkey
    FOREIGN KEY ("provider_id") REFERENCES public.delivery_providers ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_delivery_integrations ADD CONSTRAINT store_delivery_integrations_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_delivery_settings ADD CONSTRAINT store_delivery_settings_default_provider_id_fkey
    FOREIGN KEY ("default_provider_id") REFERENCES public.delivery_providers ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_delivery_settings ADD CONSTRAINT store_delivery_settings_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_feature_overrides ADD CONSTRAINT store_feature_overrides_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_members ADD CONSTRAINT store_members_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_onboarding_answers ADD CONSTRAINT store_onboarding_answers_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_order_seq ADD CONSTRAINT store_order_seq_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_pages ADD CONSTRAINT store_pages_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_payment_integrations ADD CONSTRAINT store_payment_integrations_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_role_permissions ADD CONSTRAINT store_role_permissions_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_sales_pages ADD CONSTRAINT store_sales_pages_product_id_fkey
    FOREIGN KEY ("product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_sales_pages ADD CONSTRAINT store_sales_pages_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_subscriptions ADD CONSTRAINT store_subscriptions_plan_id_fkey
    FOREIGN KEY ("plan_id") REFERENCES public.subscription_plans ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_subscriptions ADD CONSTRAINT store_subscriptions_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_theme ADD CONSTRAINT store_theme_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_theme_instances ADD CONSTRAINT store_theme_instances_preset_id_fkey
    FOREIGN KEY ("preset_id") REFERENCES public.theme_presets ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_theme_instances ADD CONSTRAINT store_theme_instances_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_theme_instances ADD CONSTRAINT store_theme_instances_theme_definition_id_fkey
    FOREIGN KEY ("theme_definition_id") REFERENCES public.theme_definitions ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_upsell_offers ADD CONSTRAINT store_upsell_offers_offer_product_id_fkey
    FOREIGN KEY ("offer_product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_upsell_offers ADD CONSTRAINT store_upsell_offers_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_upsell_offers ADD CONSTRAINT store_upsell_offers_trigger_product_id_fkey
    FOREIGN KEY ("trigger_product_id") REFERENCES public.products ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_usage ADD CONSTRAINT store_usage_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.store_wallets ADD CONSTRAINT store_wallets_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.team_members ADD CONSTRAINT team_members_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.theme_presets ADD CONSTRAINT theme_presets_theme_definition_id_fkey
    FOREIGN KEY ("theme_definition_id") REFERENCES public.theme_definitions ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.transactions ADD CONSTRAINT transactions_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_payment_id_fkey
    FOREIGN KEY ("payment_id") REFERENCES public.payments ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_store_id_fkey
    FOREIGN KEY ("store_id") REFERENCES public.platform_stores ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_wallet_id_fkey
    FOREIGN KEY ("wallet_id") REFERENCES public.store_wallets ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- =====================================================================
-- Indexes on foreign-key columns
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_activity_log_store_id ON public.activity_log ("store_id");
CREATE INDEX IF NOT EXISTS idx_agent_sessions_store_id ON public.agent_sessions ("store_id");
CREATE INDEX IF NOT EXISTS idx_campaigns_store_id ON public.campaigns ("store_id");
CREATE INDEX IF NOT EXISTS idx_carriers_store_id ON public.carriers ("store_id");
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON public.categories ("parent_id");
CREATE INDEX IF NOT EXISTS idx_categories_store_id ON public.categories ("store_id");
CREATE INDEX IF NOT EXISTS idx_checkout_settings_store_id ON public.checkout_settings ("store_id");
CREATE INDEX IF NOT EXISTS idx_clients_store_id ON public.clients ("store_id");
CREATE INDEX IF NOT EXISTS idx_coupons_store_id ON public.coupons ("store_id");
CREATE INDEX IF NOT EXISTS idx_crm_calls_store_id ON public.crm_calls ("store_id");
CREATE INDEX IF NOT EXISTS idx_delivery_integration_secrets_integration_id ON public.delivery_integration_secrets ("integration_id");
CREATE INDEX IF NOT EXISTS idx_delivery_integration_secrets_provider_id ON public.delivery_integration_secrets ("provider_id");
CREATE INDEX IF NOT EXISTS idx_delivery_integration_secrets_store_id ON public.delivery_integration_secrets ("store_id");
CREATE INDEX IF NOT EXISTS idx_delivery_shipments_integration_id ON public.delivery_shipments ("integration_id");
CREATE INDEX IF NOT EXISTS idx_delivery_shipments_order_id ON public.delivery_shipments ("order_id");
CREATE INDEX IF NOT EXISTS idx_delivery_shipments_provider_id ON public.delivery_shipments ("provider_id");
CREATE INDEX IF NOT EXISTS idx_delivery_shipments_store_id ON public.delivery_shipments ("store_id");
CREATE INDEX IF NOT EXISTS idx_delivery_tracking_events_shipment_id ON public.delivery_tracking_events ("shipment_id");
CREATE INDEX IF NOT EXISTS idx_delivery_tracking_events_store_id ON public.delivery_tracking_events ("store_id");
CREATE INDEX IF NOT EXISTS idx_finance_fixed_items_store_id ON public.finance_fixed_items ("store_id");
CREATE INDEX IF NOT EXISTS idx_invoices_payment_id ON public.invoices ("payment_id");
CREATE INDEX IF NOT EXISTS idx_invoices_store_id ON public.invoices ("store_id");
CREATE INDEX IF NOT EXISTS idx_invoices_subscription_id ON public.invoices ("subscription_id");
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_store_id ON public.onboarding_progress ("store_id");
CREATE INDEX IF NOT EXISTS idx_orders_agent_id ON public.orders ("agent_id");
CREATE INDEX IF NOT EXISTS idx_orders_bundle_id ON public.orders ("bundle_id");
CREATE INDEX IF NOT EXISTS idx_orders_client_id ON public.orders ("client_id");
CREATE INDEX IF NOT EXISTS idx_orders_product_id ON public.orders ("product_id");
CREATE INDEX IF NOT EXISTS idx_orders_store_id ON public.orders ("store_id");
CREATE INDEX IF NOT EXISTS idx_payments_store_id ON public.payments ("store_id");
CREATE INDEX IF NOT EXISTS idx_plan_limits_plan_id ON public.plan_limits ("plan_id");
CREATE INDEX IF NOT EXISTS idx_product_bundles_product_id ON public.product_bundles ("product_id");
CREATE INDEX IF NOT EXISTS idx_product_options_product_id ON public.product_options ("product_id");
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON public.product_reviews ("product_id");
CREATE INDEX IF NOT EXISTS idx_products_category_id ON public.products ("category_id");
CREATE INDEX IF NOT EXISTS idx_products_store_id ON public.products ("store_id");
CREATE INDEX IF NOT EXISTS idx_shipments_carrier_id ON public.shipments ("carrier_id");
CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON public.shipments ("order_id");
CREATE INDEX IF NOT EXISTS idx_shipments_store_id ON public.shipments ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_banners_store_id ON public.store_banners ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_custom_fields_store_id ON public.store_custom_fields ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_custom_limits_store_id ON public.store_custom_limits ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_delivery_integrations_provider_id ON public.store_delivery_integrations ("provider_id");
CREATE INDEX IF NOT EXISTS idx_store_delivery_integrations_store_id ON public.store_delivery_integrations ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_delivery_settings_default_provider_id ON public.store_delivery_settings ("default_provider_id");
CREATE INDEX IF NOT EXISTS idx_store_delivery_settings_store_id ON public.store_delivery_settings ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_feature_overrides_store_id ON public.store_feature_overrides ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_members_store_id ON public.store_members ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_onboarding_answers_store_id ON public.store_onboarding_answers ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_order_seq_store_id ON public.store_order_seq ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_pages_store_id ON public.store_pages ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_payment_integrations_store_id ON public.store_payment_integrations ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_role_permissions_store_id ON public.store_role_permissions ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_sales_pages_product_id ON public.store_sales_pages ("product_id");
CREATE INDEX IF NOT EXISTS idx_store_sales_pages_store_id ON public.store_sales_pages ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_settings_store_id ON public.store_settings ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_subscriptions_plan_id ON public.store_subscriptions ("plan_id");
CREATE INDEX IF NOT EXISTS idx_store_subscriptions_store_id ON public.store_subscriptions ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_theme_store_id ON public.store_theme ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_theme_instances_preset_id ON public.store_theme_instances ("preset_id");
CREATE INDEX IF NOT EXISTS idx_store_theme_instances_store_id ON public.store_theme_instances ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_theme_instances_theme_definition_id ON public.store_theme_instances ("theme_definition_id");
CREATE INDEX IF NOT EXISTS idx_store_upsell_offers_offer_product_id ON public.store_upsell_offers ("offer_product_id");
CREATE INDEX IF NOT EXISTS idx_store_upsell_offers_store_id ON public.store_upsell_offers ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_upsell_offers_trigger_product_id ON public.store_upsell_offers ("trigger_product_id");
CREATE INDEX IF NOT EXISTS idx_store_usage_store_id ON public.store_usage ("store_id");
CREATE INDEX IF NOT EXISTS idx_store_wallets_store_id ON public.store_wallets ("store_id");
CREATE INDEX IF NOT EXISTS idx_team_members_store_id ON public.team_members ("store_id");
CREATE INDEX IF NOT EXISTS idx_theme_presets_theme_definition_id ON public.theme_presets ("theme_definition_id");
CREATE INDEX IF NOT EXISTS idx_transactions_store_id ON public.transactions ("store_id");
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_payment_id ON public.wallet_transactions ("payment_id");
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_store_id ON public.wallet_transactions ("store_id");
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON public.wallet_transactions ("wallet_id");

-- ── uniqueness the frontend's upserts rely on (PostgREST on_conflict) ──
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_settings_store_key ON public.store_settings ("store_id", "key");
CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_progress_user ON public.onboarding_progress ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_answers_user_question ON public.onboarding_answers ("user_id", "question_key");
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_custom_limits_store ON public.store_custom_limits ("store_id");
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_delivery_settings_store ON public.store_delivery_settings ("store_id");
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_theme_store ON public.store_theme ("store_id");
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_wallets_store ON public.store_wallets ("store_id");
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallets_user ON public.wallets ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_stores_slug ON public.platform_stores ("slug");

COMMIT;
