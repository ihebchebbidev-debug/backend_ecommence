// Request context — the Node.js replacement for `auth.uid()` + RLS + the
// SECURITY DEFINER helper functions. Every REST / RPC / function handler
// receives one of these and must use it for every authorization decision.
import { q, one, tx } from '../db.js';
import { forbidden, unauthorized } from './errors.js';

export function makeContext({ userId = null, role = 'anon', claims = null } = {}) {
  const cache = new Map();
  const memo = async (key, fn) => {
    if (!cache.has(key)) cache.set(key, await fn());
    return cache.get(key);
  };

  const ctx = {
    userId,
    role, // 'anon' | 'authenticated' | 'service_role'
    claims,
    isServiceRole: role === 'service_role',
    q,
    one,
    tx,

    requireAuth() {
      if (ctx.isServiceRole) return null;
      if (!ctx.userId) throw unauthorized('JWT required');
      return ctx.userId;
    },

    // ── auth.uid() equivalents ──────────────────────────────────────
    async profile() {
      if (!ctx.userId) return null;
      return memo('profile', () =>
        one('SELECT id, email, full_name, phone, phone_verified, status, suspended_at, deleted_at FROM public.profiles WHERE id = $1', [ctx.userId]),
      );
    },

    /** is_active_user() */
    async isActiveUser() {
      if (ctx.isServiceRole) return true;
      const p = await ctx.profile();
      return !!p && p.status === 'active' && !p.deleted_at && !p.suspended_at;
    },

    /** is_phone_verified() */
    async isPhoneVerified() {
      const p = await ctx.profile();
      return !!p?.phone_verified;
    },

    /** my_admin_role() */
    async myAdminRole() {
      if (!ctx.userId) return null;
      return memo('adminRole', async () => {
        const row = await one('SELECT role FROM public.admin_roles WHERE user_id = $1 LIMIT 1', [ctx.userId]);
        return row?.role ?? null;
      });
    },

    /** is_super_admin() / _is_super_admin() */
    async isSuperAdmin() {
      if (ctx.isServiceRole) return true;
      return (await ctx.myAdminRole()) === 'super_admin';
    },

    /** is_any_admin() */
    async isAnyAdmin() {
      if (ctx.isServiceRole) return true;
      return !!(await ctx.myAdminRole());
    },

    /** _user_store_role(p_store_id) → 'owner' | 'admin' | 'manager' | 'agent' | null */
    async storeRole(storeId) {
      if (!storeId) return null;
      if (ctx.isServiceRole) return 'owner';
      if (!ctx.userId) return null;
      return memo(`role:${storeId}`, async () => {
        const owner = await one('SELECT 1 FROM public.platform_stores WHERE id = $1 AND user_id = $2', [storeId, ctx.userId]);
        if (owner) return 'owner';
        const m = await one('SELECT role FROM public.store_members WHERE store_id = $1 AND user_id = $2 LIMIT 1', [storeId, ctx.userId]);
        return m?.role ?? null;
      });
    },

    /** user_store_ids() */
    async userStoreIds() {
      if (!ctx.userId) return [];
      return memo('storeIds', async () => {
        const rows = await q(
          `SELECT id FROM public.platform_stores WHERE user_id = $1 AND deleted_at IS NULL
           UNION
           SELECT store_id AS id FROM public.store_members WHERE user_id = $1`,
          [ctx.userId],
        );
        return rows.map((r) => r.id);
      });
    },

    async hasStoreAccess(storeId) {
      if (ctx.isServiceRole) return true;
      if (await ctx.isSuperAdmin()) return true;
      return !!(await ctx.storeRole(storeId));
    },

    /** Throws unless the caller holds one of `roles` on the store. */
    async assertStoreAccess(storeId, roles = null) {
      if (ctx.isServiceRole) return 'owner';
      if (await ctx.isSuperAdmin()) return 'owner';
      const role = await ctx.storeRole(storeId);
      if (!role) throw forbidden('Access denied to this store');
      if (roles && !roles.includes(role)) throw forbidden('Insufficient role for this store');
      return role;
    },

    /** has_store_permission(p_store_id, p_permission) */
    async hasStorePermission(storeId, permission) {
      const role = await ctx.storeRole(storeId);
      if (!role) return false;
      if (role === 'owner') return true;
      const row = await one(
        'SELECT permissions FROM public.store_role_permissions WHERE store_id = $1 AND role = $2 LIMIT 1',
        [storeId, role],
      );
      const perms = row?.permissions;
      if (!perms) return role === 'admin';
      if (Array.isArray(perms)) return perms.includes(permission);
      return perms[permission] === true;
    },

    /** can_view_customer_data(p_store_id) — the customer-data lock system. */
    async canViewCustomerData(storeId) {
      if (ctx.isServiceRole) return true;
      if (await ctx.isSuperAdmin()) return true;
      const role = await ctx.storeRole(storeId);
      if (!role) return false;
      const sub = await one(
        `SELECT customer_data_locked, status FROM public.store_subscriptions
         WHERE store_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [storeId],
      );
      if (sub?.customer_data_locked === true) return false;
      if (role === 'owner' || role === 'admin') return true;
      return ctx.hasStorePermission(storeId, 'view_customer_data');
    },
  };

  return ctx;
}

export const serviceContext = () => makeContext({ role: 'service_role' });
