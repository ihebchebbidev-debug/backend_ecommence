// Delivery RPCs — spec 3.7. Never expose encrypted credential columns.
import { syncOrderDeliveryStatus } from '../functions/_shared/delivery.js';
import { forbidden } from '../lib/errors.js';
import { permission } from '../lib/commerce.js';

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

/** Live (non-test) First Delivery parcels that the carrier can still cancel through its API. */
export function needsCarrierCancel(shipment) {
  return shipment.provider_code === 'first_delivery'
    && !!shipment.tracking_number
    && !String(shipment.tracking_number).startsWith('TEST-')
    && shipment.test_mode !== true
    && ['created', 'pending', 'picked_up'].includes(shipment.status);
}

export default {
  async get_store_delivery_integrations({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    return ctx.q(
      `SELECT
         ${PROVIDER_COLUMNS},
         dp.integration_mode,
          sdi.enabled,
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
         sdi.last_test_at, sdi.last_verified_at,
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
         ds.updated_at,
         EXISTS (SELECT 1 FROM public.store_plan_usage pu WHERE pu.order_id = ds.order_id AND pu.commission_status = 'unpaid') AS plan_hidden
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

    // Same rule as the orders list: an unpaid plan commission hides that order's customer.
    return rows.map(({ plan_hidden: planHidden, ...r }) => {
      const visible = canViewCustomerData && !planHidden;
      return {
        ...r,
        client_name: visible ? r.client_name : null,
        client_phone: visible ? r.client_phone : null,
        customer_data_visible: visible,
      };
    });
  },

  async update_delivery_shipment_status({ p_shipment_id, p_store_id, p_new_status }, ctx) {
    await ctx.assertStoreAccess(p_store_id, ['owner', 'admin', 'manager']);
    // Changing a shipment also changes its order, so it needs the same right as editing orders.
    await permission(ctx, p_store_id, 'canManageOrders');

    const shipment = await ctx.one(
      `SELECT ds.id, ds.order_id, ds.status, ds.tracking_number, dp.code AS provider_code, sdi.test_mode
         FROM public.delivery_shipments ds
         LEFT JOIN public.delivery_providers dp ON dp.id = ds.provider_id
         LEFT JOIN public.store_delivery_integrations sdi ON sdi.store_id = ds.store_id AND sdi.provider_id = ds.provider_id
        WHERE ds.id = $1 AND ds.store_id = $2`,
      [p_shipment_id, p_store_id],
    );
    if (!shipment) throw forbidden('Shipment not found for this store');

    // A live First Delivery parcel must be cancelled at the carrier first (cancel-delivery-shipment);
    // recording it locally would leave the parcel active at the carrier.
    if (p_new_status === 'cancelled' && needsCarrierCancel(shipment)) {
      return { success: true, needs_api_cancel: true, shipment_id: p_shipment_id };
    }

    await ctx.q(
      `UPDATE public.delivery_shipments SET status = $1, updated_at = now() WHERE id = $2`,
      [p_new_status, p_shipment_id],
    );

    await ctx.q(
      `INSERT INTO public.delivery_tracking_events (shipment_id, store_id, event_type, status, description)
       VALUES ($1, $2, 'status_update', $3, $3)`,
      [p_shipment_id, p_store_id, p_new_status],
    );

    await syncOrderDeliveryStatus(ctx, shipment.order_id, p_store_id, p_new_status);
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
        WHERE sdi.store_id = $1 AND sdi.enabled = true AND sdi.status = 'connected'
          AND (sdi.has_credentials = true OR dp.integration_mode = 'manual')
          AND dp.is_active = true AND dp.is_visible_to_stores = true
       ORDER BY dp.sort_order, dp.name`,
      [p_store_id],
    );
  },
};
