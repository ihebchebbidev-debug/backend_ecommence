// Payments RPCs — spec 3.8. Never expose encrypted credential columns.
export default {
  async get_store_payment_integration_safe({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    return ctx.q(
      `SELECT
         id,
         provider,
         is_active,
         connection_status,
         (credentials_encrypted IS NOT NULL) AS has_credentials,
         last_tested_at,
         created_at,
         updated_at
       FROM public.store_payment_integrations
       WHERE store_id = $1
       ORDER BY created_at`,
      [p_store_id],
    );
  },

  async get_store_public_payment_options({ p_store_id }, ctx) {
    return ctx.q(
      `SELECT provider
       FROM public.store_payment_integrations
       WHERE store_id = $1 AND is_active = true AND connection_status = 'connected'
       ORDER BY provider`,
      [p_store_id],
    );
  },
};
