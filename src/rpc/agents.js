// SQL RPC functions: agent / team-member session operations (spec 3.4).
import { forbidden, unauthorized, badRequest } from '../lib/errors.js';
import coupons from './coupons.js';
import builder from './builder.js';
import billing from './billing.js';

// Permissions, shops and the confirmation-agent flag are re-read from the member
// row on every call, so an owner's change (or deactivation) applies immediately.
async function loadSession(ctx, sessionId) {
  const session = await ctx.one(
    `SELECT s.id, s.store_id, m.name AS member_name, s.expires_at, s.team_member_id,
            m.role AS member_role, m.permissions, m.status, m.store_id AS home_store_id,
            COALESCE(m.store_ids, '{}') AS store_ids, COALESCE(m.is_confirmation_agent, false) AS is_confirmation_agent
     FROM public.agent_sessions s JOIN public.team_members m ON m.id = s.team_member_id
     WHERE s.id = $1`,
    [sessionId],
  );
  if (!session) throw unauthorized('Invalid session');
  if (session.status !== 'active') throw unauthorized('Account disabled');
  if (!session.expires_at || !Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at) <= new Date()) {
    throw unauthorized('Session expired');
  }
  const shops = await memberStores(ctx, session.home_store_id, session.store_ids);
  if (!shops.some(shop => shop.id === session.store_id)) throw forbidden('Shop access revoked');
  return session;
}

/** Shops a member may work in: home shop + extra shops that belong to the same owner. */
async function memberStores(ctx, homeStoreId, extra) {
  const ids = [homeStoreId, ...(extra || [])].filter(Boolean);
  return ctx.q(
    `SELECT s.id, s.store_name, s.slug, s.logo_url FROM public.platform_stores s
     WHERE s.id = ANY($1::uuid[]) AND s.deleted_at IS NULL AND s.status = 'active'
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
  return perms[key]?.[act] === true && (act === 'read' || perms[key]?.read === true);
}

function need(session, key, action = 'read') {
  if (!hasPermission(session, key, action)) throw forbidden('Insufficient permissions');
}

// Order statuses a confirmation agent works with (never shipping/delivery stages).
export const CONFIRMATION_STATUSES = ['pending', 'confirmed', 'tentative_1', 'tentative_2', 'answered', 'wrong_number', 'attempt1', 'attempt2', 'rejected'];

// Module → table map for the session-checked team data API. Each module's
// read/create/modify/delete flag from the permission matrix is enforced here.
export const TEAM_MODULES = {
  produits:    { table: 'products', search: 'name', soft: true, fields: ['name','name_ar','name_fr','description','description_ar','description_fr','short_description','price','cost','stock','sku','status','category_id','image_url','delivery_cost','delivery_fee'] },
  categories:  { table: 'categories', search: 'name', fields: ['name','slug','description','image_url','color','parent_id'] },
  clients:     { table: 'clients', search: 'name', soft: true, fields: ['name','phone','email','city','region','note','status'] },
  codes_promo: { table: 'coupons', search: 'code', fields: ['code','type','value','active','min_order_amount','starts_at','expires_at','max_uses'] },
  livraison:   { table: 'delivery_shipments', search: 'tracking_number', fields: [] },
  marketing:   { table: 'campaigns', search: 'name', fields: ['name','platform','budget','start_date','end_date','status','leads','spend','roas'] },
  avis:        { table: 'product_reviews', fields: ['comment','customer_name','image_url','product_id','rating','sort_order','status'], parent: { table: 'products', column: 'product_id' } },
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

/** Adapter grants only the already-checked operation, never a blanket owner session. */
function scopedContext(ctx, session) {
  return {
    ...ctx,
    userId: session.team_member_id,
    requireAuth: () => session.team_member_id,
    isActiveUser: async () => true,
    assertStoreAccess: async storeId => {
      if (storeId !== session.store_id) throw forbidden('Shop not assigned');
      return 'admin';
    },
    hasStorePermission: async (storeId, key) => storeId === session.store_id && key === 'canManageCoupons',
    tx: fn => asMember(ctx, session, t => fn({ ...t })),
  };
}

export default {
  async agent_logout({p_session_id}, ctx) {
    const session = await loadSession(ctx,p_session_id);
    await ctx.q('DELETE FROM public.agent_sessions WHERE id=$1',[session.id]);
    return {success:true};
  },
  async team_owner_members({p_store_id}, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id,['owner','admin']);
    return ctx.q(`SELECT m.id,m.store_id,m.store_ids,m.name,m.first_name,m.last_name,m.username,m.email,m.phone,m.role,m.shift,m.status,m.available,m.permissions,m.is_confirmation_agent,m.last_login_at,m.created_at,
      EXISTS(SELECT 1 FROM public.agent_sessions s WHERE s.team_member_id=m.id AND s.expires_at>now() AND s.last_seen_at>now()-interval '90 seconds') AS online
      FROM public.team_members m JOIN public.platform_stores h ON h.id=m.store_id
      WHERE (m.store_id=$1 OR $1=ANY(m.store_ids)) AND h.user_id=(SELECT user_id FROM public.platform_stores WHERE id=$1)
      ORDER BY m.name,m.id`,[p_store_id]);
  },
  async team_performance({p_store_id,p_from=null,p_to=null},ctx) {
    ctx.requireAuth(); await ctx.assertStoreAccess(p_store_id,['owner','admin']);
    for(const date of [p_from,p_to]) if(date!==null && !Number.isFinite(Date.parse(date))) throw badRequest('Invalid date');
    return ctx.q(`WITH outcomes AS (
      SELECT DISTINCT ON (team_member_id,entity_id) team_member_id,user_name,entity_id,metadata->>'to' AS outcome
      FROM public.activity_log WHERE store_id=$1 AND action='order_status' AND metadata->>'from' IS DISTINCT FROM metadata->>'to'
      AND metadata->>'to'=ANY($4::text[]) AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at <= $3)
      ORDER BY team_member_id,entity_id,created_at DESC,id DESC
    ) SELECT team_member_id,max(user_name) AS name,count(*)::int AS processed,
      count(*) FILTER(WHERE outcome='confirmed')::int AS confirmed,
      count(*) FILTER(WHERE outcome='rejected')::int AS cancelled,
      count(*) FILTER(WHERE outcome IN ('attempt1','tentative_1'))::int AS attempt1,
      count(*) FILTER(WHERE outcome IN ('attempt2','tentative_2'))::int AS attempt2,
      count(*) FILTER(WHERE outcome='answered')::int AS answered,
      count(*) FILTER(WHERE outcome='wrong_number')::int AS wrong_number
      FROM outcomes GROUP BY team_member_id ORDER BY confirmed DESC,processed DESC,team_member_id`,
      [p_store_id,p_from,p_to,CONFIRMATION_STATUSES.filter(s=>s!=='pending')]);
  },

  async team_builder({ p_session_id, p_action, ...args }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    const methods = { get: 'builder_get_draft', save: 'builder_save_draft', publish: 'builder_publish', versions: 'builder_list_versions', restore: 'builder_restore_version' };
    const method = methods[p_action];
    if (!method) throw badRequest('Unknown builder action');
    need(session, 'boutique', ['get','versions'].includes(p_action) ? 'read' : 'modify');
    const adapter = scopedContext(ctx, session);
    // updated_by/published_by reference authenticated users: retain the shop owner;
    // the activity trigger independently records the verified member actor.
    adapter.userId = (await ctx.one('SELECT user_id FROM public.platform_stores WHERE id=$1', [session.store_id])).user_id;
    return builder[method]({ ...args, p_store_id: session.store_id }, adapter);
  },
  async team_save_member({ p_store_id, p_member_id = null, p_values = {} }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, ['owner','admin']);
    return ctx.tx(async t => {
      const home = await t.one('SELECT id,user_id FROM public.platform_stores WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [p_store_id]);
      if (!home) throw forbidden('Shop unavailable');
      if (p_member_id && !await t.one('SELECT id FROM public.team_members WHERE id=$1 AND store_id=$2 FOR UPDATE',[p_member_id,p_store_id])) throw forbidden('Member unavailable');
      const storeIds = [...new Set([p_store_id, ...(Array.isArray(p_values.store_ids) ? p_values.store_ids : [])])];
      const shops = await t.q('SELECT id FROM public.platform_stores WHERE id=ANY($1::uuid[]) AND user_id=$2 AND deleted_at IS NULL',[storeIds,home.user_id]);
      if (shops.length !== storeIds.length) throw forbidden('All assigned shops must belong to the same owner');
      const username = String(p_values.username || '').trim().toLowerCase();
      const email = String(p_values.email || '').trim().toLowerCase();
      if (!username || !String(p_values.name || '').trim()) throw badRequest('Name and username required');
      const duplicate = await t.one(`SELECT id FROM public.team_members WHERE ($1::uuid IS NULL OR id<>$1) AND
        (lower(username)=$2 OR ($3<>'' AND lower(email)=$3)) LIMIT 1`, [p_member_id,username,email]);
      if (duplicate) throw badRequest('Username or email already in use');
      if (!p_member_id) {
        if (!/^[a-f0-9]{64}$/.test(p_values.password_hash || '')) throw badRequest('Password required');
        const max = await billing.plan_limit({p_store_id,p_limit_key:'max_team_members'},{...ctx,q:t.q,one:t.one});
        const count = await t.one('SELECT count(*)::int AS count FROM public.team_members WHERE store_id=$1',[p_store_id]);
        if (max == null || (max > 0 && count.count >= max)) throw forbidden('Team member limit reached');
      }
      const allowed = ['name','first_name','last_name','phone','role','shift','available','status','permissions','password_hash','is_confirmation_agent'];
      const values = Object.fromEntries(Object.entries(p_values).filter(([key]) => allowed.includes(key)));
      if (values.password_hash && !/^[a-f0-9]{64}$/.test(values.password_hash)) throw badRequest('Invalid password');
      values.username=username; values.email=email || null; values.store_ids=storeIds;
      if (!values.permissions || typeof values.permissions !== 'object' || Array.isArray(values.permissions) || Object.values(values.permissions).some(actions => !actions || typeof actions !== 'object' || Array.isArray(actions) || Object.entries(actions).some(([key,value]) => !['read','create','modify','delete'].includes(key) || typeof value !== 'boolean'))) throw badRequest('Invalid permissions');
      if (values.is_confirmation_agent && !await billing.plan_allows({p_store_id,p_feature_key:'has_confirmation_agents'}, {...ctx,q:t.q,one:t.one})) throw forbidden('Confirmation agents unavailable on this plan');
      if (!['active','inactive'].includes(values.status)) throw badRequest('Invalid member status');
      if (values.is_confirmation_agent != null && typeof values.is_confirmation_agent !== 'boolean') throw badRequest('Invalid confirmation agent flag');
      const keys = Object.keys(values);
      const encoded = keys.map(key => key === 'permissions' ? JSON.stringify(values[key]) : values[key]);
      const row = p_member_id
        ? await t.one(`UPDATE public.team_members SET ${keys.map((key,i)=>`"${key}"=$${i+2}`).join(',')} WHERE id=$1 RETURNING id`,[p_member_id,...encoded])
        : await t.one(`INSERT INTO public.team_members (store_id,created_at,${keys.map(key=>`"${key}"`).join(',')}) VALUES ($1,now(),${keys.map((_,i)=>`$${i+2}`).join(',')}) RETURNING id`,[p_store_id,...encoded]);
      if (values.password_hash || values.status !== 'active') await t.q('DELETE FROM public.agent_sessions WHERE team_member_id=$1',[row.id]);
      await t.q(`INSERT INTO public.activity_log(store_id,team_member_id,user_name,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,'team_member',$5,$6)`, [p_store_id,null,'Propriétaire',p_member_id ? 'member_update' : 'member_create',row.id,values.name]);
      return row;
    });
  },
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
    const count = await ctx.one(`SELECT COUNT(*)::int AS total FROM public.orders WHERE ${conds.join(' AND ')}`, params.slice(0, -2));
    const locked = await ctx.one('SELECT customer_data_locked FROM public.store_subscriptions WHERE store_id=$1 ORDER BY created_at DESC LIMIT 1', [session.store_id]);
    const visible = locked?.customer_data_locked !== true;
    return { data: visible ? rows : rows.map(r => ({ ...r, client_name: '••••', client_phone: '', region: '', notes: null })), total: count?.total ?? rows.length, customer_data_visible: visible };
  },

  async agent_get_products({ p_session_id, p_search = null }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    need(session, 'produits');
    const conds = ['store_id = $1', 'deleted_at IS NULL'];
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
    need(session, 'commandes', 'modify');

    if (!['pending','confirmed','tentative_1','tentative_2','answered','wrong_number','attempt1','attempt2','rejected','shipped','transit','delivered','returned'].includes(p_status)) throw badRequest('Invalid order status');
    return asMember(ctx, session, async t => {
      const order = await t.one('SELECT id, status FROM public.orders WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL FOR UPDATE', [p_order_id, session.store_id]);
      if (!order) throw forbidden('Order not found in this store');
      if (session.is_confirmation_agent && (!CONFIRMATION_STATUSES.includes(p_status) || !CONFIRMATION_STATUSES.includes(order.status || 'pending'))) throw forbidden('Confirmation agents can only handle orders awaiting confirmation');
      const row = await t.one(`UPDATE public.orders SET status=$1, notes=COALESCE($2,notes), agent_id=$5, agent_name=$6, confirmation_status=CASE WHEN $1=ANY($7::text[]) THEN $1 ELSE confirmation_status END, confirmed_at=CASE WHEN $1='confirmed' THEN COALESCE(confirmed_at,now()) ELSE confirmed_at END, updated_at=now() WHERE id=$3 AND store_id=$4 RETURNING id,status,notes,updated_at`, [p_status,p_notes,p_order_id,session.store_id,session.team_member_id,session.member_name,CONFIRMATION_STATUSES]);
      await t.q(`INSERT INTO public.activity_log (store_id,team_member_id,user_name,action,entity_type,entity_id,details,ip,metadata,created_at)
        VALUES ($1,$2,$3,'order_status','order',$4,$5,$6,$7::jsonb,now())`, [session.store_id,session.team_member_id,session.member_name,p_order_id,`${order.status} → ${p_status}`,ctx.requestIp || null,JSON.stringify({from:order.status,to:p_status})]);
      return row;
    });
  },

  async team_validate_session({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    await ctx.q('UPDATE public.agent_sessions SET last_seen_at=now() WHERE id=$1',[session.id]);
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
    need(session, 'statistiques');
    const row = await ctx.one(`SELECT count(*)::int AS total_orders,
      count(*) FILTER (WHERE status='confirmed')::int AS confirmed_orders,
      count(*) FILTER (WHERE status='delivered')::int AS delivered_orders,
      count(*) FILTER (WHERE status='pending')::int AS pending_orders,
      COALESCE(sum(amount) FILTER (WHERE status='delivered'),0) AS total_revenue
      FROM public.orders WHERE store_id=$1 AND deleted_at IS NULL
      AND ($2::boolean=false OR status=ANY($3::text[]))`, [session.store_id,session.is_confirmation_agent,CONFIRMATION_STATUSES]);
    const store = await ctx.one('SELECT currency FROM public.platform_stores WHERE id=$1',[session.store_id]);
    return {...row,currency:store?.currency};
  },

  async team_get_store_info({ p_session_id }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    need(session, 'boutique');
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
    const data = await ctx.q(
      `SELECT id, name, first_name, last_name, role, status, online, available
       FROM public.team_members WHERE store_id = $1 OR $1 = ANY(store_ids)`,
      [session.store_id],
    );
    return { data };
  },

  async team_get_products({ p_session_id, p_search = null, p_limit = 50, p_offset = 0 }, ctx) {
    const session = await loadSession(ctx, p_session_id);
    need(session, 'produits');
    const conds = ['store_id = $1', 'deleted_at IS NULL'];
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
    return ctx.tx(async t => {
    await t.q('UPDATE public.agent_sessions SET store_id = $1 WHERE id = $2', [p_store_id, session.id]);
    await t.q(`INSERT INTO public.activity_log (store_id, team_member_id, user_name, action, entity_type, details, ip, created_at)
      VALUES ($1,$2,$3,'store_switch','team_member',$4,$5,now())`,
      [p_store_id, session.team_member_id, session.member_name, 'Changement de boutique', ctx.requestIp || null]);
    return { store_id: p_store_id };
    });
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
    const mod = Object.prototype.hasOwnProperty.call(TEAM_MODULES, p_module) ? TEAM_MODULES[p_module] : null;
    const act = Object.prototype.hasOwnProperty.call(ACTIONS, p_action) ? ACTIONS[p_action] : null;
    if (!mod || !act) throw badRequest('Unknown module or action');
    const session = await loadSession(ctx, p_session_id);
    need(session, p_module, act);

    if (['clients','livraison'].includes(p_module)) {
      const sub = await ctx.one('SELECT customer_data_locked FROM public.store_subscriptions WHERE store_id=$1 ORDER BY created_at DESC LIMIT 1', [session.store_id]);
      if (sub?.customer_data_locked === true) throw forbidden('Customer data locked');
    }
    if (p_action === 'update' && !p_id) throw badRequest('Missing id');
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

    if (p_module === 'livraison') throw forbidden('Use the carrier shipment workflow; direct shipment writes are forbidden');
    if (p_module === 'codes_promo') {
      const adapter = scopedContext(ctx, session);
      if (p_action === 'delete') return coupons.set_store_coupon_active({ p_store_id: session.store_id, p_coupon_id: p_id, p_active: false }, adapter);
      return coupons.save_store_coupon({ p_store_id: session.store_id, p_coupon_id: p_action === 'update' ? p_id : null, p_coupon: p_values }, adapter);
    }
    const values = Object.fromEntries(Object.entries(p_values || {}).filter(([k]) => cols.has(k) && mod.fields.includes(k)));
    for (const key of ['price','cost','stock','delivery_cost','delivery_fee','budget','leads','spend','roas']) {
      if (values[key] != null && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0)) throw badRequest('Invalid numeric value');
    }
    if (values.stock != null && !Number.isInteger(Number(values.stock))) throw badRequest('Stock must be an integer');
    if (values.rating != null && (!Number.isInteger(Number(values.rating)) || Number(values.rating) < 1 || Number(values.rating) > 5)) throw badRequest('Rating must be between 1 and 5');
    if (p_action === 'create' && !mod.parent && !String(values.name || '').trim()) throw badRequest('Name required');
    if (p_module === 'categories' && p_action === 'create' && !String(values.slug || '').trim()) throw badRequest('Slug required');

    return asMember(ctx, session, async (t) => {
      for (const key of ['category_id','parent_id']) {
        if (values[key] && !await t.one('SELECT id FROM public.categories WHERE id=$1 AND store_id=$2', [values[key],session.store_id])) throw forbidden('Category not in this shop');
        if (key === 'parent_id' && values[key] === p_id) throw badRequest('Category cannot be its own parent');
      }
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
      const owned = await t.one(`SELECT id FROM public.${mod.table} WHERE id = $2 AND ${scope} FOR UPDATE`, [session.store_id, p_id]);
      if (!owned) throw forbidden('Not found in this shop');

      if (p_action === 'delete') {
        if (soft) await t.q(`UPDATE public.${mod.table} SET deleted_at = now() WHERE id = $1`, [p_id]);
        else await t.q(`DELETE FROM public.${mod.table} WHERE id = $1`, [p_id]);
        return { id: p_id, deleted: true };
      }

      if (mod.parent) delete values[mod.parent.column];
      if (!Object.keys(values).length) throw badRequest('No writable values');
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
