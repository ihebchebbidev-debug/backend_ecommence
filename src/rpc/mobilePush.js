// Phone notification device lifecycle for the native seller app (seller accounts only).
// A token belongs to one account + shop at a time; registering it again moves it, so a
// shared phone never keeps receiving the previous account's or shop's alerts.
import { badRequest, forbidden } from '../lib/errors.js';
import { id } from '../lib/commerce.js';

const TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/;
export const PUSH_LANGUAGES = ['fr', 'en', 'ar'];

export function pushToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw badRequest('Invalid push token');
  return value;
}

export default {
  async mobile_register_push({ p_store_id, p_token, p_platform, p_language }, ctx) {
    ctx.requireAuth();
    if (!ctx.userId || !(await ctx.isActiveUser())) throw forbidden('Active user session required');
    const storeId = id(p_store_id);
    await ctx.assertStoreAccess(storeId);
    const token = pushToken(p_token);
    if (!['ios', 'android'].includes(p_platform)) throw badRequest('Invalid platform');
    const language = PUSH_LANGUAGES.includes(p_language) ? p_language : 'fr';
    await ctx.q(`INSERT INTO public.push_devices(user_id,store_id,token,platform,language)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, store_id=EXCLUDED.store_id, platform=EXCLUDED.platform,
        language=EXCLUDED.language, last_seen_at=now(), revoked_at=NULL,
        created_at=CASE WHEN push_devices.user_id=EXCLUDED.user_id AND push_devices.store_id=EXCLUDED.store_id THEN push_devices.created_at ELSE now() END`,
      [ctx.userId, storeId, token, p_platform, language]);
    return { registered: true };
  },
  /** Called on sign-out, shop switch or when the seller turns alerts off. Only the owner can revoke. */
  async mobile_unregister_push({ p_token }, ctx) {
    ctx.requireAuth();
    const token = pushToken(p_token);
    await ctx.q('UPDATE public.push_devices SET revoked_at=now() WHERE token=$1 AND user_id=$2 AND revoked_at IS NULL', [token, ctx.userId]);
    return { revoked: true };
  },
};
