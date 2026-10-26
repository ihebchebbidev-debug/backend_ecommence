// Account deletion (Apple 5.1.1(v) / Google Play account deletion).
// Re-authenticates with the password, then in one transaction: closes every shop the
// user owns, removes their memberships in other shops, anonymizes the login and profile,
// and revokes every session. Platform billing records are kept for legal retention.
import bcrypt from 'bcryptjs';
import { badRequest, forbidden } from '../lib/errors.js';

export const DELETE_CONFIRMATION = 'DELETE';

export async function deleteAccount(ctx, { p_password, p_confirm }) {
  ctx.requireAuth();
  if (!ctx.userId) throw forbidden('A user session is required');
  if (String(p_confirm || '').trim().toUpperCase() !== DELETE_CONFIRMATION) throw badRequest('Confirmation required');
  const user = await ctx.one('SELECT id, encrypted_password FROM auth.users WHERE id = $1 AND deleted_at IS NULL', [ctx.userId]);
  if (!user) throw forbidden('Account unavailable');
  const ok = user.encrypted_password && await bcrypt.compare(String(p_password || ''), user.encrypted_password);
  if (!ok) throw forbidden('Mot de passe incorrect');

  return ctx.tx(async t => {
    const shops = await t.q(`UPDATE public.platform_stores SET status = 'deleted', deleted_at = now()
      WHERE user_id = $1 AND deleted_at IS NULL RETURNING id`, [ctx.userId]);
    await t.q('DELETE FROM public.store_members WHERE user_id = $1', [ctx.userId]);
    const anon = `deleted+${ctx.userId}@deleted.invalid`;
    await t.q(`UPDATE auth.users SET email = $2, phone = NULL, encrypted_password = NULL, deleted_at = now(), updated_at = now() WHERE id = $1`, [ctx.userId, anon]);
    await t.q(`UPDATE public.profiles SET email = $2, full_name = NULL, phone = NULL, avatar_url = NULL, status = 'deleted', deleted_at = now() WHERE id = $1`, [ctx.userId, anon]);
    await t.q('DELETE FROM auth.refresh_tokens WHERE user_id = $1', [ctx.userId]);
    await t.q('DELETE FROM auth.sessions WHERE user_id = $1', [ctx.userId]);
    return { deleted: true, shops_deleted: shops.length };
  });
}

export default {
  account_delete: (args, ctx) => deleteAccount(ctx, args || {}),
};
