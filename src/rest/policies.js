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
// hidden: columns stripped from every REST response (credential material).

const store = (extra = {}) => ({ scope: 'store', storeColumn: 'store_id', ...extra });
const user = (col = 'user_id', extra = {}) => ({ scope: 'user', userColumn: col, ...extra });
const catalog = (extra = {}) => ({ scope: 'catalog', ...extra });
const admin = (extra = {}) => ({ scope: 'admin', ...extra });
const denied = () => ({ scope: 'denied' });

export const policies = {
  // ── store-scoped operational data ───────────────────────────────────
  activity_log: store(),
  agent_sessions: denied(),
  campaigns: store(),
  carriers: store({ publicRead: true }),
  categories: store({ publicRead: true }),
  checkout_settings: store({ publicRead: true }),
  clients: store({ writeRoles: ['owner', 'admin', 'manager'] }),
  coupons: store({ publicRead: true }),
  crm_calls: store(),
  delivery_integration_secrets: denied(),
  delivery_shipments: store(),
  delivery_tracking_events: store(),
  finance_fixed_items: store(),
  invoices: store(),
  orders: store({ publicInsert: true }),
  products: store({ publicRead: true }),
  product_bundles: store({ storeColumn: null, parent: { table: 'products', column: 'product_id' }, publicRead: true }),
  product_options: store({ storeColumn: null, parent: { table: 'products', column: 'product_id' }, publicRead: true }),
  product_reviews: store({ storeColumn: null, parent: { table: 'products', column: 'product_id' }, publicRead: true, publicInsert: true }),
  shipments: store(),
  store_banners: store({ publicRead: true }),
  store_custom_fields: store({ publicRead: true }),
  store_custom_limits: admin(),
  store_delivery_integrations: store({ hidden: ['credentials_encrypted', 'credentials_iv', 'credentials_version'] }),
  store_delivery_settings: store(),
  // Store members may read their own store's overrides (live "overrides_select_own_store"); only super admins write.
  store_feature_overrides: store({ writeRoles: [] }),
  store_members: store({ writeRoles: ['owner', 'admin'] }),
  store_onboarding_answers: store(),
  store_order_seq: denied(),
  store_pages: store({ publicRead: true }),
  store_payment_integrations: store({
    writeRoles: ['owner', 'admin'],
    hidden: ['credentials_encrypted', 'credentials_iv', 'credentials_version'],
  }),
  store_role_permissions: store({ writeRoles: ['owner', 'admin'] }),
  store_sales_pages: store({ publicRead: true }),
  store_settings: store({ publicRead: true }),
  store_subscriptions: store({ writeRoles: ['owner'] }),
  store_theme: store({ publicRead: true }),
  store_theme_instances: store({ publicRead: true }),
  store_upsell_offers: store({ publicRead: true }),
  store_usage: store({ writeRoles: [] }),
  store_wallets: store({ writeRoles: [] }),
  team_members: store({ writeRoles: ['owner', 'admin'], hidden: ['password_hash'] }),
  transactions: store(),
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
  },

  // ── user-scoped ────────────────────────────────────────────────────
  admin_roles: user('user_id', { writeRoles: [] }),
  // Onboarding progress belongs to the USER: the row exists before any store does.
  onboarding_progress: user('user_id', { alsoStore: 'store_id' }),
  onboarding_answers: user(),
  otp_verification_logs: user('user_id', { writeRoles: [] }),
  payments: user('user_id', { alsoStore: 'store_id' }),
  wallets: user(),
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
  ip_blacklist: admin(),
  otp_rate_limit_resets: admin(),
  payment_gateway_settings: admin({ hidden: ['api_key', 'api_secret', 'credentials_encrypted', 'credentials_iv'] }),
  phone_blacklist: admin(),
  phone_settings_audit: admin(),
  phone_verification_settings: admin(),
  whatsapp_webhook_events: admin(),

  // ── never over REST ────────────────────────────────────────────────
  phone_otp_codes: denied(),
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
