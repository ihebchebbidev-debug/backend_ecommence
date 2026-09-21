// Delivery RPCs — spec 3.7. Never expose encrypted credential columns.
import { forbidden } from '../lib/errors.js';

const PROVIDER_COLUMNS = `
  dp.id AS provider_id,
  dp.code AS provider_code,
  dp.name AS provider_name,
  dp.logo_url,
  dp.supports_label,
  dp.supports_tracking,
  dp.supports_return,
  dp.supports_open_package
`;

export default {
  async get_store_delivery_integrations({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    return ctx.q(
      `SELECT
         ${PROVIDER_COLUMNS},
         sdi.integration_mode,
         sdi.has_credentials,
         sdi.default_provider,
         sdi.delivery_cost_tnd,
         sdi.return_cost_tnd,
         sdi.status
       FROM public.store_delivery_integrations sdi
       JOIN public.delivery_providers dp ON dp.id = sdi.provider_id
       WHERE sdi.store_id = $1
       ORDER BY dp.sort_order, dp.name`,
      [p_store_id],
    );
  },

  async get_store_delivery_integrations_safe({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    return ctx.q(
      `SELECT
         sdi.id AS integration_id,
         sdi.created_at,
         sdi.default_provider,
         sdi.delivery_cost_tnd,
         sdi.enabled,
         sdi.has_credentials,
         sdi.label_enabled,
         sdi.last_error,
         sdi.last_test_at,
         sdi.localities_last_synced_at,
         sdi.masked_credentials,
         sdi.provider_code,
         sdi.provider_settings,
         sdi.return_cost_tnd,
         sdi.sender_config,
         sdi.status,
         sdi.test_mode,
         sdi.tracking_enabled,
         sdi.updated_at,
         dp.id AS provider_id,
         dp.name AS provider_name,
         dp.description AS provider_description,
         dp.logo_url AS provider_logo_url,
         dp.integration_mode AS provider_integration_mode,
         dp.credentials_schema AS provider_credentials_schema,
         dp.sender_schema AS provider_sender_schema,
         dp.settings_schema AS provider_settings_schema,
         dp.supports_cod AS provider_supports_cod,
         dp.supports_label AS provider_supports_label,
         dp.supports_tracking AS provider_supports_tracking,
         dp.supports_return AS provider_supports_return,
         dp.supports_open_package AS provider_supports_open_package,
         dp.supports_webhook AS provider_supports_webhook
       FROM public.store_delivery_integrations sdi
       JOIN public.delivery_providers dp ON dp.id = sdi.provider_id
       WHERE sdi.store_id = $1
       ORDER BY dp.sort_order, dp.name`,
      [p_store_id],
    );
  },

  async get_store_delivery_shipments({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const canViewCustomerData = await ctx.canViewCustomerData(p_store_id);

    const rows = await ctx.q(
      `SELECT
         ds.id,
         ds.order_id,
         o.order_number,
         o.status AS order_status,
         o.client_name,
         o.client_phone,
         o.region,
         o.amount,
         o.currency,
         ds.provider_code,
         dp.name AS provider_name,
         ds.tracking_number,
         ds.tracking_url,
         ds.label_url,
         ds.status AS delivery_status,
         sdi.delivery_cost_tnd,
         sdi.return_cost_tnd,
         te.event_type AS last_event_type,
         te.created_at AS last_event_at,
         ds.created_at,
         ds.updated_at
       FROM public.delivery_shipments ds
       JOIN public.orders o ON o.id = ds.order_id
       LEFT JOIN public.delivery_providers dp ON dp.id = ds.provider_id
       LEFT JOIN public.store_delivery_integrations sdi
         ON sdi.store_id = ds.store_id AND sdi.provider_code = ds.provider_code
       LEFT JOIN LATERAL (
         SELECT event_type, created_at
         FROM public.delivery_tracking_events
         WHERE shipment_id = ds.id
         ORDER BY created_at DESC
         LIMIT 1
       ) te ON true
       WHERE ds.store_id = $1
       ORDER BY ds.created_at DESC`,
      [p_store_id],
    );

    return rows.map((r) => ({
      ...r,
      client_name: canViewCustomerData ? r.client_name : null,
      client_phone: canViewCustomerData ? r.client_phone : null,
      customer_data_visible: canViewCustomerData,
    }));
  },

  async update_delivery_shipment_status({ p_shipment_id, p_store_id, p_new_status }, ctx) {
    await ctx.assertStoreAccess(p_store_id, ['owner', 'admin', 'manager']);

    const shipment = await ctx.one(
      'SELECT id FROM public.delivery_shipments WHERE id = $1 AND store_id = $2',
      [p_shipment_id, p_store_id],
    );
    if (!shipment) throw forbidden('Shipment not found for this store');

    await ctx.q(
      `UPDATE public.delivery_shipments SET status = $1, updated_at = now() WHERE id = $2`,
      [p_new_status, p_shipment_id],
    );

    await ctx.q(
      `INSERT INTO public.delivery_tracking_events (shipment_id, store_id, event_type, status, description)
       VALUES ($1, $2, 'status_update', $3, $3)`,
      [p_shipment_id, p_store_id, p_new_status],
    );

    return { success: true, shipment_id: p_shipment_id, status: p_new_status };
  },

  async get_connected_delivery_providers({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    return ctx.q(
      `SELECT
         ${PROVIDER_COLUMNS},
         sdi.default_provider,
         sdi.delivery_cost_tnd,
         sdi.return_cost_tnd,
         sdi.status
       FROM public.store_delivery_integrations sdi
       JOIN public.delivery_providers dp ON dp.id = sdi.provider_id
       WHERE sdi.store_id = $1 AND sdi.enabled = true AND sdi.has_credentials = true
       ORDER BY dp.sort_order, dp.name`,
      [p_store_id],
    );
  },
};
