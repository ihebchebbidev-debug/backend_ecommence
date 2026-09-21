// 3.1 Authentication & User Management.
// Store-management functions live in ./stores.js only — they used to be
// duplicated here and were silently shadowed by that file in the registry.
import { forbidden, unauthorized } from '../lib/errors.js';

export default {
  /** ensure_user_profile(p_email?, p_full_name?, p_country?) → { status }[] */
  async ensure_user_profile({ p_email, p_full_name, p_country }, ctx) {
    const userId = ctx.requireAuth();
    if (!userId) return [{ status: 'service_role' }];
    const existing = await ctx.one('SELECT id, status FROM public.profiles WHERE id = $1', [userId]);
    if (existing) return [{ status: existing.status }];
    const row = await ctx.one(
      `INSERT INTO public.profiles (id, email, full_name, country)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
       RETURNING status`,
      [userId, p_email ?? '', p_full_name ?? '', p_country ?? ''],
    );
    return [{ status: row?.status ?? 'active' }];
  },

  /** check_user_status(p_user_id) → { status }[] — self only. */
  async check_user_status({ p_user_id }, ctx) {
    const userId = ctx.requireAuth();
    if (!ctx.isServiceRole && p_user_id !== userId) {
      throw forbidden('Can only check your own status');
    }
    const row = await ctx.one('SELECT status FROM public.profiles WHERE id = $1', [p_user_id]);
    if (!row) return [];
    return [{ status: row.status }];
  },

  /** agent_login(p_username, p_password_hash) → Json session info */
  async agent_login({ p_username, p_password_hash }, ctx) {
    const member = await ctx.one(
      `SELECT id, store_id, name, role, permissions, status
       FROM public.team_members WHERE username = $1 AND password_hash = $2`,
      [p_username, p_password_hash],
    );
    if (!member || member.status === 'inactive') {
      throw unauthorized('Invalid username or password');
    }
    const session = await ctx.one(
      `INSERT INTO public.agent_sessions (team_member_id, store_id, store_user_id, member_name, member_role, permissions, expires_at)
       VALUES ($1, $2, (SELECT user_id FROM public.platform_stores WHERE id = $2), $3, $4, $5, now() + interval '12 hours')
       RETURNING id`,
      [member.id, member.store_id, member.name, member.role, member.permissions],
    );
    return {
      session_id: session.id,
      store_id: member.store_id,
      member_name: member.name,
      member_role: member.role,
      permissions: member.permissions,
    };
  },

  /** agent_check_username(p_username, p_exclude_id?, p_store_id?) → boolean */
  async agent_check_username({ p_username, p_exclude_id, p_store_id }, ctx) {
    if (!p_username) return false;
    const conditions = ['username = $1'];
    const params = [p_username];
    if (p_exclude_id) {
      params.push(p_exclude_id);
      conditions.push(`id <> $${params.length}`);
    }
    if (p_store_id) {
      params.push(p_store_id);
      conditions.push(`store_id = $${params.length}`);
    }
    const row = await ctx.one(
      `SELECT 1 FROM public.team_members WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    );
    return !!row;
  },
};
