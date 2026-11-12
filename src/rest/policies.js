// Table access rules — the explicit Node.js re-implementation of the 268 RLS
// policies. Every table in the schema must appear here; anything missing is
// denied by default.
//
// scope:
//   'store'    → row belongs to a store; access = membership in that store
//   'user'     → row belongs to a user;  access = auth.uid() matches
//   'profile'  → profiles table (id = auth.uid())
//   'catalog'  → global reference data, readable by everyone
//   'admin'    → admins only
//   'denied'   → never reachable over REST (secrets, internal tables)
//
// publicRead: storefront tables an anonymous visitor may read when filtered by
// store_id (matching the live "public storefront" policies).
// writePermission: role permission (store_role_permissions key) every REST write
// also requires, so switching a feature off for a role closes generic writes.
// hidden: columns stripped from every REST response (credential material).

const store = (extra = {}) => ({ scope: 'store', storeColumn: 'store_id', ...extra });
const user = (col = 'user_id', extra = {}) => ({ scope: 'user', userColumn: col, ...extra });
const catalog = (extra = {}) => ({ scope: 'catalog', ...extra });
const admin = (extra = {}) => ({ scope: 'admin', ...extra });
const denied = () => ({ scope: 'denied' });

export const policies = {
  // ── store-scoped operational data ───────────────────────────────────
  activity_log: store({ writeRoles: [] }),
  agent_sessions: denied(),
  store_plan_state: denied(),
  store_plan_usage: denied(),
  store_plan_events: denied(),
  campaigns: store({ writePermission: 'canManageAutomations' }),
  carriers: store({ publicRead: true }),
  categories: store({ publicRead: true, writePermission: 'canManageProducts' }),
  checkout_settings: store({ publicRead: true, writePermission: 'canManageSettings' }),
  clients: store({ writeRoles: ['owner', 'admin', 'manager'], writePermission: 'canManageCustomers', planMaskClients: ['name', 'phone', 'phone2', 'email', 'address', 'city', 'notes'] }),
  // Writes/reads go through permission-checked coupon RPCs; no public enumeration.
  coupons: store({ writeRoles: [] }),
  commerce_notifications: denied(),
  commerce_notification_reads: denied(),
  coupon_redemptions: denied(),
  store_loyalty_settings: denied(),
  store_loyalty_accounts: denied(),
  store_loyalty_ledger: denied(),
  commerce_attempts: denied(),
  crm_calls: store({ writePermission: 'canManageCustomers' }),
  delivery_integration_secrets: denied(),
  delivery_shipments: store({ writeRoles: ['owner', 'admin', 'manager'], writePermission: 'canManageOrders' }),
  delivery_tracking_events: store({ writeRoles: ['owner', 'admin', 'manager'], writePermission: 'canManageOrders' }),
  finance_fixed_items: store({ writePermission: 'canViewAnalytics' }),
  invoices: store({ writePermission: 'canManagePayments' }),
  // Per-shop fraud lists; rows without store_id are legacy platform entries (admin only).
  ip_blacklist: store({ writePermission: 'canManageSettings' }),
  phone_blacklist: store({ writePermission: 'canManageSettings' }),
  orders: store({ writeRoles: ['owner', 'admin', 'manager', 'seller', 'support'], writePermission: 'canManageOrders', planMask: ['client_name', 'client_phone', 'client_phone2', 'address', 'notes', 'confirmation_notes'] }), // Public checkout must use validated create_public_order.
  products: store({ publicRead: true, writeRoles: ['owner', 'admin', 'manager', 'seller'], writePermission: 'canManageProducts' }),
  product_bundles: store({ storeColumn: null, parent: { table: 'products', column: 'product_id' }, publicRead: true, writePermission: 'canManageProducts' }),
  product_options: store({ storeColumn: null, parent: { table: 'products', column: 'product_id' }, publicRead: true, writePermission: 'canManageProducts' }),
  product_reviews: store({ storeColumn: null, parent: { table: 'products', column: 'product_id' }, publicRead: true, publicInsert: true, writePermission: 'canManageProducts' }),
  shipments: store({ writePermission: 'canManageOrders' }),
  store_banners: store({ publicRead: true, writePermission: 'canManageSettings' }),
  store_custom_fields: store({ publicRead: true, writePermission: 'canManageSettings' }),
  store_custom_limits: admin(),
  store_delivery_integrations: store({ writeRoles: ['owner', 'admin'], writePermission: 'canManageSettings', hidden: ['credentials_encrypted', 'credentials_iv', 'credentials_version'] }),
  store_delivery_settings: store({ writeRoles: ['owner', 'admin'], writePermission: 'canManageSettings' }),
  // Store members may read their own store's overrides (live "overrides_select_own_store"); only super admins write.
  store_feature_overrides: store({ writeRoles: [] }),
  store_form_submissions: denied(), // Read only through the staff-checked RPC; submissions only through published forms.
  store_domain_requests: denied(), // Domain ownership and activation only through protected RPCs.
  store_members: store({ writeRoles: ['owner'] }), // Only the owner may grant roles, so admins cannot self-promote.
  store_onboarding_answers: store(),
  store_order_seq: denied(),
  store_pages: store({ publicRead: true, writePermission: 'canManageSettings' }),
  store_payment_integrations: store({
    writeRoles: ['owner', 'admin'],
    writePermission: 'canManagePayments',
    hidden: ['credentials_encrypted', 'credentials_iv', 'credentials_version'],
  }),
  store_role_permissions: store({ writeRoles: ['owner'] }),
  store_sales_pages: store({ publicRead: true, writePermission: 'canManageProducts' }),
  store_settings: store({ publicRead: true, writePermission: 'canManageSettings' }),
  store_subscriptions: store({ writeRoles: ['owner'] }),
  store_theme: store({ publicRead: true, writePermission: 'canManageSettings' }),
  store_theme_instances: store({ publicRead: true, writePermission: 'canManageSettings' }),
  store_upsell_offers: store({ publicRead: true, writePermission: 'canManageProducts' }),
  store_usage: store({ writeRoles: [] }),
  store_wallets: store({ writeRoles: [] }),
  team_members: store({ writeRoles: ['owner', 'admin'], writePermission: 'canManageTeam', hidden: ['password_hash'] }),
  transactions: store({ writePermission: 'canManagePayments' }),
  wallet_transactions: store({ writeRoles: [] }),

  // ── store registry ─────────────────────────────────────────────────
  platform_stores: {
    scope: 'store',
    storeColumn: 'id',
    // Creating a store has no store to be a member of yet: ownership comes
    // from user_id, exactly like the live "users create their own store" policy.
    ownerColumn: 'user_id',
    publicRead: true,
    writeRoles: ['owner', 'admin'],
    hidden: ['internal_notes', 'quarantine_reason', 'remediation_action'],
    adminVisible: ['internal_notes', 'quarantine_reason', 'remediation_action'],
  },

  // ── user-scoped ────────────────────────────────────────────────────
  admin_roles: user('user_id', { writeRoles: [] }),
  // Onboarding progress belongs to the USER: the row exists before any store does.
  onboarding_progress: user('user_id', { alsoStore: 'store_id' }),
  onboarding_answers: user(),
  otp_verification_logs: user('user_id', { writeRoles: [] }),
  payments: user('user_id', { alsoStore: 'store_id' }),
  // Balances change only through billing RPCs (credit/debit with ledger), never by their owner.
  wallets: user('user_id', { writeRoles: [] }),
  profiles: { scope: 'profile' },

  // ── global catalogue (read-only for everyone, admin writes) ────────
  currency_rates: catalog(),
  delivery_providers: catalog(),
  delivery_provider_localities: catalog(),
  plans: catalog(),
  plan_limits: catalog(),
  subscription_plans: catalog(),
  theme_definitions: catalog(),
  theme_presets: catalog(),
  platform_settings: catalog(),

  // ── admin-only ─────────────────────────────────────────────────────
  admin_audit_logs: admin(),
  audit_logs: admin(),
  otp_rate_limit_resets: admin(),
  payment_gateway_settings: admin({ hidden: ['api_key', 'api_secret', 'credentials_encrypted', 'credentials_iv'] }),
  phone_settings_audit: admin(),
  phone_verification_settings: admin(),
  whatsapp_webhook_events: admin(),

  // ── never over REST ────────────────────────────────────────────────
  phone_otp_codes: denied(),
  platform_messaging_settings: denied(),
  auth_otp_codes: denied(),
  ad_match_consents: denied(),
  meta_capi_sent: denied(),
  store_meta_capi: denied(),
  site_visits: denied(),
  api_request_logs: denied(),
};

export function policyFor(table) {
  return Object.prototype.hasOwnProperty.call(policies, table) ? policies[table] : null;
}

/**
 * Register an access rule for a table created after boot (auto-migration).
 * Never overwrites a hand-written rule — declared policies always win.
 */
export function registerPolicy(table, policy, { auto = false } = {}) {
  if (Object.prototype.hasOwnProperty.call(policies, table)) return policies[table];
  policies[table] = { ...policy, autoRegistered: auto };
  return policies[table];
}
