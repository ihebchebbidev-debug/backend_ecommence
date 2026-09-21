// SQL RPC functions: agent / team-member session operations (spec 3.4).
import { forbidden, unauthorized } from '../lib/errors.js';

async function loadSession(ctx, sessionId) {
  const session = await ctx.one(
    `SELECT id, store_id, member_name, member_role, permissions, expires_at, team_member_id
     FROM public.agent_sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session) throw unauthorized('Invalid session');
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    throw unauthorized('Session expired');
  }
  return session;
}

function hasPermission(session, permission) {
  const perms = session.permissions;
  if (!perms) return session.member_role === 'admin' || session.member_role === 'owner';
  if (Array.isArray(perms)) return perms.includes(permission);
  return perms[permission] === true;
}

export default {
  async agent_get_orders(args, ctx) {
    const { p_session_id, p_status = null, p_search = null, p_limit = 50, p_offset = 0 } = args;
    const session = await loadSession(ctx, p_session_id);

    const conds = ['store_id = $1', 'deleted_at IS NULL'];
    const params = [session.store_id];
    if (p_status) {
      params.push(p_status);
      conds.push(`status = $${params.length}`);
    }
    if (p_search) {
      params.push(`%${p_search}%`);
      conds.push(`(client_name ILIKE $${params.length} OR client_phone ILIKE $${params.length} OR order_number ILIKE $${params.length})`);
    }
    params.push(p_limit);
    const limitIdx = params.length;
    params.push(p_offset);
    const offsetIdx = params.length;

    const rows = await ctx.q(
      `SELECT id, order_number, client_name, client_phone, product_name, quantity, amount,
              status, region, notes, created_at, updated_at, confirmation_status, currency
       FROM public.orders
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows;
  },

  async agent_get_products({ p_session_id, p_search = null }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const conds = ['store_id = $1'];
    const params = [session.store_id];
    if (p_search) {
      params.push(`%${p_search}%`);
      conds.push(`name ILIKE $${params.length}`);
    }
    return ctx.q(
      `SELECT id, name, price, image_url, stock, status, sku
       FROM public.products WHERE ${conds.join(' AND ')} ORDER BY name ASC`,
      params,
    );
  },

  async agent_update_order({ p_session_id, p_order_id, p_status, p_notes = null }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    if (!hasPermission(session, 'update_orders')) throw forbidden('Insufficient permissions');

    const order = await ctx.one('SELECT id FROM public.orders WHERE id = $1 AND store_id = $2', [
      p_order_id,
      session.store_id,
    ]);
    if (!order) throw forbidden('Order not found in this store');

    const row = await ctx.one(
      `UPDATE public.orders SET status = $1, notes = COALESCE($2, notes), updated_at = now()
       WHERE id = $3 RETURNING id, status, notes, updated_at`,
      [p_status, p_notes, p_order_id],
    );
    return row;
  },

  async team_validate_session({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    return [
      {
        store_id: session.store_id,
        member_name: session.member_name,
        member_role: session.member_role,
        permissions: session.permissions,
      },
    ];
  },

  async team_get_stats({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const counts = await ctx.q(
      `SELECT status, COUNT(*)::int AS cnt FROM public.orders WHERE store_id = $1 AND deleted_at IS NULL GROUP BY status`,
      [session.store_id],
    );
    const totalRow = await ctx.one(
      `SELECT COUNT(*)::int AS total FROM public.orders WHERE store_id = $1 AND deleted_at IS NULL`,
      [session.store_id],
    );
    return { total_orders: totalRow?.total ?? 0, by_status: counts };
  },

  async team_get_store_info({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const store = await ctx.one(
      `SELECT id, store_name, slug, currency, country, logo_url, store_color
       FROM public.platform_stores WHERE id = $1`,
      [session.store_id],
    );
    return store;
  },

  async team_get_members({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    return ctx.q(
      `SELECT id, name, first_name, last_name, role, status, online, available
       FROM public.team_members WHERE store_id = $1`,
      [session.store_id],
    );
  },

  async team_get_products({ p_session_id, p_search = null, p_limit = 50, p_offset = 0 }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const conds = ['store_id = $1'];
    const params = [session.store_id];
    if (p_search) {
      params.push(`%${p_search}%`);
      conds.push(`name ILIKE $${params.length}`);
    }
    params.push(p_limit);
    const limitIdx = params.length;
    params.push(p_offset);
    const offsetIdx = params.length;
    return ctx.q(
      `SELECT id, name, price, image_url, stock, status, sku
       FROM public.products WHERE ${conds.join(' AND ')}
       ORDER BY name ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
  },

  async team_get_categories({ p_session_id, p_search = null }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const conds = ['store_id = $1'];
    const params = [session.store_id];
    if (p_search) {
      params.push(`%${p_search}%`);
      conds.push(`name ILIKE $${params.length}`);
    }
    return ctx.q(
      `SELECT id, name, slug, parent_id, image_url, color FROM public.categories
       WHERE ${conds.join(' AND ')} ORDER BY name ASC`,
      params,
    );
  },
};
