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
      `SELECT id, name, phone, email, city, region, status, note, created_at, updated_at, store_id
       FROM public.clients WHERE store_id = $1`,
      [p_store_id],
    );
    return rows.map((c) => ({
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
