// SQL RPC functions: clients (spec 3.5).
function maskName(name) {
  if (name === null || name === undefined || name === '') return '********';
  return '********';
}

function maskPhone(phone) {
  if (phone === null || phone === undefined || phone === '') return '********';
  if (typeof phone === 'string' && phone.startsWith('+216')) return '+216 ** *** ***';
  return '********';
}

export default {
  async get_store_clients_secure({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const canView = await ctx.canViewCustomerData(p_store_id);
    const rows = await ctx.q(
      `SELECT c.id, c.name, c.phone, c.email, c.city, c.region, c.status, c.note, c.created_at, c.updated_at, c.store_id,
         (EXISTS (SELECT 1 FROM public.orders o JOIN public.store_plan_usage pu ON pu.order_id = o.id AND pu.commission_status = 'unpaid' WHERE o.client_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.client_id = c.id AND o.status IS DISTINCT FROM 'abandoned'
            AND NOT EXISTS (SELECT 1 FROM public.store_plan_usage pu WHERE pu.order_id = o.id AND pu.commission_status = 'unpaid'))) AS plan_hidden
       FROM public.clients c WHERE c.store_id = $1`,
      [p_store_id],
    );
    return rows.map((c) => ({ c, canView: canView && c.plan_hidden !== true })).map(({ c, canView }) => ({
      id: c.id,
      name: canView ? c.name : maskName(c.name),
      phone: canView ? c.phone : maskPhone(c.phone),
      email: canView ? c.email : null,
      city: c.city,
      region: c.region,
      status: c.status,
      note: canView ? c.note : null,
      created_at: c.created_at,
      updated_at: c.updated_at,
      store_id: c.store_id,
      customer_data_visible: canView,
    }));
  },

  async can_view_customer_data({ p_store_id }, ctx) {
    return ctx.canViewCustomerData(p_store_id);
  },

  async update_customer_data_lock_status({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id, ['owner', 'admin']);
    const sub = await ctx.one(
      `SELECT id, customer_data_locked FROM public.store_subscriptions
       WHERE store_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [p_store_id],
    );
    if (sub) {
      await ctx.q(
        `UPDATE public.store_subscriptions SET customer_data_locked = NOT customer_data_locked, customer_data_locked_at = now()
         WHERE id = $1`,
        [sub.id],
      );
    }
    return null;
  },

  async mask_client_name({ p_name }) {
    return maskName(p_name);
  },

  async mask_client_phone({ p_phone }) {
    return maskPhone(p_phone);
  },
};
