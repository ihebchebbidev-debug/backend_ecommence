import { json, methodGuard, assertAccountUsable } from './_shared/respond.js';
import { readPaymentStore, storePaymentUrls } from './_shared/storePaymentUrls.js';

export default async function paymentUrls(req, res, ctx) {
  if (methodGuard(req, res)) return;
  const { store_id, provider } = req.body || {};
  if (!store_id || !['konnect', 'paymee', 'flouci', 'stripe', 'clictopay'].includes(provider)) return json(res, { error: 'Invalid payment settings' }, 400);
  if (!ctx.userId) return json(res, { error: 'Unauthenticated' }, 401);
  if (!await assertAccountUsable(ctx, res)) return;
  if (!await ctx.isSuperAdmin()) {
    const membership = await ctx.q('SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND role = ANY($3)', [store_id, ctx.userId, ['owner', 'admin']]);
    if (!membership.length) return json(res, { error: 'Shop access denied' }, 403);
  }
  const store = await readPaymentStore(ctx, store_id);
  if (!store || store.status !== 'active') return json(res, { error: 'Shop unavailable' }, 403);
  try { return json(res, storePaymentUrls(store, provider)); }
  catch { return json(res, { error: 'Public payment addresses are not configured' }, 503); }
}