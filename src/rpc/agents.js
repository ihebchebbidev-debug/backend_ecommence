// SQL RPC functions: agent / team-member session operations (spec 3.4).
import { forbidden, unauthorized, badRequest } from '../lib/errors.js';

// Permissions, shops and the confirmation-agent flag are re-read from the member
// row on every call, so an owner's change (or deactivation) applies immediately.
async function loadSession(ctx, sessionId) {
  const session = await ctx.one(
    `SELECT s.id, s.store_id, s.member_name, s.expires_at, s.team_member_id,
            m.role AS member_role, m.permissions, m.status, m.store_id AS home_store_id,
            COALESCE(m.store_ids, '{}') AS store_ids, COALESCE(m.is_confirmation_agent, false) AS is_confirmation_agent
     FROM public.agent_sessions s JOIN public.team_members m ON m.id = s.team_member_id
     WHERE s.id = $1`,
    [sessionId],
  );
  if (!session) throw unauthorized('Invalid session');
  if (session.status === 'inactive') throw unauthorized('Account disabled');
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    throw unauthorized('Session expired');
  }
  return session;
}

/** Shops a member may work in: home shop + extra shops that belong to the same owner. */
async function memberStores(ctx, homeStoreId, extra) {
  const ids = [homeStoreId, ...(extra || [])].filter(Boolean);
  return ctx.q(
    `SELECT s.id, s.store_name, s.slug, s.logo_url FROM public.platform_stores s
     WHERE s.id = ANY($1::uuid[]) AND s.deleted_at IS NULL
       AND s.user_id = (SELECT user_id FROM public.platform_stores WHERE id = $2)
     ORDER BY (s.id = $2) DESC, s.store_name`,
    [ids, homeStoreId],
  );
}

// Legacy flat permission names → seller-app section keys ({ commandes: { read, modify } }).
const LEGACY = { update_orders: ['commandes', 'modify'] };

/** Accepts the seller-app shape `{ section: { read, create, modify, delete } }`, legacy flat flags, or arrays. */
function hasPermission(session, permission, action = 'read') {
  const perms = session.permissions;
  if (!perms) return session.member_role === 'admin' || session.member_role === 'owner';
  if (Array.isArray(perms)) return perms.includes(permission);
  if (perms[permission] === true) return true;
  const [key, act] = LEGACY[permission] || [permission, action];
  return perms[key]?.[act] === true;
}

function need(session, key, action = 'read') {
  if (!hasPermission(session, key, action)) throw forbidden('Insufficient permissions');
}

// Order statuses a confirmation agent works with (never shipping/delivery stages).
export const CONFIRMATION_STATUSES = ['pending', 'confirmed', 'tentative_1', 'tentative_2', 'answered', 'wrong_number', 'attempt1', 'attempt2', 'rejected'];

// Module → table map for the session-checked team data API. Each module's
// read/create/modify/delete flag from the permission matrix is enforced here.
export const TEAM_MODULES = {
  produits:    { table: 'products', search: 'name', soft: true },
  categories:  { table: 'categories', search: 'name' },
  clients:     { table: 'clients', search: 'name' },
  codes_promo: { table: 'coupons', search: 'code' },
  livraison:   { table: 'delivery_shipments', search: 'tracking_number' },
  marketing:   { table: 'campaigns', search: 'name' },
  avis:        { table: 'product_reviews', parent: { table: 'products', column: 'product_id' } },
};
const ACTIONS = { list: 'read', create: 'create', update: 'modify', delete: 'delete' };
const NEVER_WRITE = new Set(['id', 'store_id', 'created_at', 'password_hash', 'credentials_encrypted', 'credentials_iv', 'credentials_version']);

async function tableColumns(ctx, table) {
  const rows = await ctx.q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/** Runs a write as the member so the activity triggers record who did it. */
async function asMember(ctx, session, fn) {
  return ctx.tx(async (t) => {
    await t.q(`SELECT set_config('app.actor_name', $1, true), set_config('app.actor_member_id', $2, true)`,
      [session.member_name || 'Membre', String(session.team_member_id)]);
    return fn(t);
  });
}

export default {
  async agent_get_orders(args, ctx) {
    const { p_session_id, p_status = null, p_search = null, p_limit = 50, p_offset = 0 } = args;
    const session = await loadSession(ctx, p_session_id);
    need(session, 'commandes');

    const conds = ['store_id = $1', 'deleted_at IS NULL'];
    const params = [session.store_id];
    if (session.is_confirmation_agent) {
      params.push(CONFIRMATION_STATUSES);
      conds.push(`COALESCE(status, 'pending') = ANY($${params.length}::text[])`);
    }
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
    need(session, 'produits');
    const conds = ['store_id = $1'];
    const params = [session.store_id];
    if (p_search) {
      params.push(`%${p_search}%`);
      conds.push(`name ILIKE $${params.length}`);
    }
    return ctx.q(
      `SELECT id, name, price, image_url, stock, status, sku,
              (SELECT s.currency FROM public.platform_stores s WHERE s.id = products.store_id) AS currency
       FROM public.products WHERE ${conds.join(' AND ')} ORDER BY name ASC`,
      params,
    );
  },

  async agent_update_order({ p_session_id, p_order_id, p_status, p_notes = null }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    need(session, 'update_orders');

    const order = await ctx.one('SELECT id, status FROM public.orders WHERE id = $1 AND store_id = $2', [
      p_order_id,
      session.store_id,
    ]);
    if (!order) throw forbidden('Order not found in this store');
    if (session.is_confirmation_agent
      && (!CONFIRMATION_STATUSES.includes(p_status) || !CONFIRMATION_STATUSES.includes(order.status || 'pending'))) {
      throw forbidden('Confirmation agents can only handle orders awaiting confirmation');
    }

    const row = await ctx.one(
      `UPDATE public.orders SET status = $1, notes = COALESCE($2, notes), updated_at = now()
       WHERE id = $3 RETURNING id, status, notes, updated_at`,
      [p_status, p_notes, p_order_id],
    );
    await ctx.q(`INSERT INTO public.activity_log (store_id, team_member_id, user_name, action, entity_type, entity_id, details, ip, created_at)
      VALUES ($1,$2,$3,'order_status','order',$4,$5,$6,now())`,
      [session.store_id, session.team_member_id, session.member_name, p_order_id, `Statut de commande → ${p_status}`, ctx.requestIp || null]).catch(() => {});
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
        is_confirmation_agent: session.is_confirmation_agent,
        stores: await memberStores(ctx, session.home_store_id, session.store_ids),
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
    need(session, 'personnel');
    return ctx.q(
      `SELECT id, name, first_name, last_name, role, status, online, available
       FROM public.team_members WHERE store_id = $1`,
      [session.store_id],
    );
  },

  async team_get_products({ p_session_id, p_search = null, p_limit = 50, p_offset = 0 }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    need(session, 'produits');
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
    need(session, 'categories');
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

  /** Shops this member can switch between. */
  async team_list_stores({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    return memberStores(ctx, session.home_store_id, session.store_ids);
  },

  /** Moves the session to another assigned shop (same owner only). */
  async team_switch_store({ p_session_id, p_store_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const stores = await memberStores(ctx, session.home_store_id, session.store_ids);
    if (!stores.some((s) => s.id === p_store_id)) throw forbidden('Shop not assigned to this member');
    await ctx.q('UPDATE public.agent_sessions SET store_id = $1 WHERE id = $2', [p_store_id, session.id]);
    await ctx.q(`INSERT INTO public.activity_log (store_id, team_member_id, user_name, action, entity_type, details, ip, created_at)
      VALUES ($1,$2,$3,'store_switch','team_member',$4,$5,now())`,
      [p_store_id, session.team_member_id, session.member_name, 'Changement de boutique', ctx.requestIp || null]).catch(() => {});
    return { store_id: p_store_id };
  },

  /**
   * team_module(p_session_id, p_module, p_action, p_id?, p_values?, p_search?, p_limit?, p_offset?)
   * One session-checked entry point for every data module; the member's
   * read/create/modify/delete flag for that module is enforced server-side.
   */
  async team_module(args, ctx) {
    const { p_session_id, p_module, p_action = 'list', p_id = null, p_values = {}, p_search = null } = args;
    const limit = Math.min(Math.max(Number(args.p_limit) || 50, 1), 200);
    const offset = Math.max(Number(args.p_offset) || 0, 0);
    const mod = TEAM_MODULES[p_module];
    const act = ACTIONS[p_action];
    if (!mod || !act) throw badRequest('Unknown module or action');
    const session = await loadSession(ctx, p_session_id);
    need(session, p_module, act);

    const cols = await tableColumns(ctx, mod.table);
    const scope = mod.parent
      ? `${mod.parent.column} IN (SELECT id FROM public.${mod.parent.table} WHERE store_id = $1)`
      : 'store_id = $1';
    const soft = mod.soft && cols.has('deleted_at');

    if (p_action === 'list') {
      const conds = [scope];
      const params = [session.store_id];
      if (soft) conds.push('deleted_at IS NULL');
      if (p_search && mod.search && cols.has(mod.search)) {
        params.push(`%${p_search}%`);
        conds.push(`${mod.search}::text ILIKE $${params.length}`);
      }
      params.push(limit, offset);
      const hidden = [...cols].filter((c) => NEVER_WRITE.has(c) && c.startsWith('credentials') || c === 'password_hash');
      const select = hidden.length ? [...cols].filter((c) => !hidden.includes(c)).map((c) => `"${c}"`).join(', ') : '*';
      return ctx.q(
        `SELECT ${select} FROM public.${mod.table} WHERE ${conds.join(' AND ')}
         ORDER BY ${cols.has('created_at') ? 'created_at DESC NULLS LAST' : 'id'}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
    }

    const values = Object.fromEntries(
      Object.entries(p_values || {}).filter(([k]) => cols.has(k) && !NEVER_WRITE.has(k) && /^[a-z_][a-z0-9_]*$/.test(k)),
    );

    return asMember(ctx, session, async (t) => {
      if (p_action === 'create') {
        if (mod.parent) {
          const parentId = values[mod.parent.column];
          const ok = parentId && await t.one(`SELECT 1 FROM public.${mod.parent.table} WHERE id = $1 AND store_id = $2`, [parentId, session.store_id]);
          if (!ok) throw forbidden('Parent not in this shop');
        } else {
          values.store_id = session.store_id;
        }
        if (cols.has('created_at')) values.created_at = new Date().toISOString();
        const keys = Object.keys(values);
        if (!keys.length) throw badRequest('No values');
        return t.one(
          `INSERT INTO public.${mod.table} (${keys.map((k) => `"${k}"`).join(', ')})
           VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          keys.map((k) => values[k]),
        );
      }

      if (!p_id) throw badRequest('Missing id');
      const owned = await t.one(`SELECT id FROM public.${mod.table} WHERE id = $2 AND ${scope}`, [session.store_id, p_id]);
      if (!owned) throw forbidden('Not found in this shop');

      if (p_action === 'delete') {
        if (soft) await t.q(`UPDATE public.${mod.table} SET deleted_at = now() WHERE id = $1`, [p_id]);
        else await t.q(`DELETE FROM public.${mod.table} WHERE id = $1`, [p_id]);
        return { id: p_id, deleted: true };
      }

      if (mod.parent) delete values[mod.parent.column];
      if (cols.has('updated_at')) values.updated_at = new Date().toISOString();
      const keys = Object.keys(values);
      if (!keys.length) throw badRequest('No values');
      return t.one(
        `UPDATE public.${mod.table} SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id`,
        [p_id, ...keys.map((k) => values[k])],
      );
    });
  },
};
