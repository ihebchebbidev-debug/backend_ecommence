// Port of supabase/functions/admin-delete-auth-user/index.ts
import { json, methodGuard } from './_shared/respond.js';

export default async function adminDeleteAuthUser(req, res, ctx) {
  if (methodGuard(req, res)) return;

  try {
    if (!ctx.userId) return json(res, { error: 'Missing authorization header' }, 401);

    const adminRole = await ctx.q(
      'SELECT role, email FROM public.admin_roles WHERE user_id=$1',
      [ctx.userId],
    ).then((r) => r[0]);

    if (!adminRole || adminRole.role !== 'super_admin' || adminRole.email !== 'douchd414@gmail.com') {
      return json(res, { error: 'Unauthorized: super admin access required' }, 403);
    }

    const callerProfile = await ctx.q('SELECT status FROM public.profiles WHERE id=$1', [ctx.userId]).then((r) => r[0]);
    if (!callerProfile || callerProfile.status !== 'active') {
      return json(res, { error: 'Unauthorized: account not active' }, 403);
    }

    const body = req.body || {};
    const { target_user_id, mode, confirm_delete } = body;

    if (!target_user_id) return json(res, { error: 'target_user_id is required' }, 400);
    if (mode !== 'suspend' && mode !== 'delete' && mode !== 'reactivate') {
      return json(res, { error: "mode must be 'suspend', 'delete', or 'reactivate'" }, 400);
    }
    if (target_user_id === ctx.userId) {
      return json(res, { error: 'Cannot suspend or delete your own account' }, 400);
    }

    if (mode === 'suspend') {
      try {
        await ctx.q(
          `UPDATE public.profiles SET status='suspended', suspended_at=now() WHERE id=$1`,
          [target_user_id],
        );
      } catch (e) {
        await ctx.q(
          `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
          ['suspend_user', target_user_id, ctx.userId, JSON.stringify({ result: 'error', error: e.message })],
        );
        return json(res, { error: `Failed to suspend profile: ${e.message}` }, 500);
      }

      await ctx.q(
        `UPDATE public.store_members SET status='suspended', deleted_at=now() WHERE user_id=$1 AND status='active'`,
        [target_user_id],
      );

      await ctx.q(
        `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
        ['suspend_user', target_user_id, ctx.userId, JSON.stringify({ result: 'success' })],
      );

      return json(res, { success: true, mode: 'suspend', target_user_id });
    }

    if (mode === 'reactivate') {
      try {
        await ctx.q(
          `UPDATE public.profiles SET status='active', suspended_at=NULL, deleted_at=NULL WHERE id=$1`,
          [target_user_id],
        );
      } catch (e) {
        return json(res, { error: `Failed to reactivate profile: ${e.message}` }, 500);
      }

      await ctx.q(
        `UPDATE public.store_members SET status='active', deleted_at=NULL WHERE user_id=$1 AND status='suspended'`,
        [target_user_id],
      );

      await ctx.q(
        `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
        ['reactivate_user', target_user_id, ctx.userId, JSON.stringify({ result: 'success' })],
      );

      return json(res, { success: true, mode: 'reactivate', target_user_id });
    }

    // ── Delete mode ──

    let affectedStores = [];
    try {
      affectedStores = await ctx.q(
        `SELECT * FROM admin_cascade_soft_delete_user_stores($1, $2)`,
        [target_user_id, ctx.userId],
      );
    } catch (e) {
      await ctx.q(
        `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
        ['delete_user', target_user_id, ctx.userId, JSON.stringify({ result: 'error', step: 'cascade_soft_delete_stores', error: e.message })],
      );
      return json(res, { error: `Failed to cascade-delete user stores: ${e.message}` }, 500);
    }

    const storesWithData = affectedStores.filter((s) => s.orders_count > 0);
    if (storesWithData.length > 0 && !confirm_delete) {
      return json(res, {
        error: 'Confirmation required',
        requires_confirmation: true,
        stores_with_data: storesWithData.map((s) => ({
          store_id: s.store_id,
          store_name: s.store_name,
          orders_count: s.orders_count,
        })),
        message: `This user owns ${storesWithData.length} store(s) with real order data. Re-send with confirm_delete=true to proceed.`,
      }, 409);
    }

    try {
      await ctx.q(
        `UPDATE public.profiles SET status='deleted', deleted_at=now() WHERE id=$1`,
        [target_user_id],
      );
    } catch (e) {
      await ctx.q(
        `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
        ['delete_user', target_user_id, ctx.userId, JSON.stringify({ result: 'error', step: 'profile_update', error: e.message })],
      );
      return json(res, { error: `Failed to mark profile deleted: ${e.message}` }, 500);
    }

    await ctx.q(
      `UPDATE public.store_members SET status='deleted', deleted_at=now() WHERE user_id=$1`,
      [target_user_id],
    );

    await ctx.q(
      `UPDATE public.store_subscriptions SET status='cancelled', updated_at=now() WHERE user_id=$1`,
      [target_user_id],
    );

    // Delete the local auth user (replaces the Supabase admin API call).
    let authDeleted = true;
    let authErrorMsg = null;
    try {
      await ctx.q('DELETE FROM auth.users WHERE id=$1', [target_user_id]);
    } catch (e) {
      authDeleted = false;
      authErrorMsg = e.message;
    }

    if (!authDeleted) {
      await ctx.q(
        `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
        ['delete_user', target_user_id, ctx.userId, JSON.stringify({
          result: 'partial_success',
          profile_status: 'deleted',
          auth_deleted: false,
          auth_error: authErrorMsg,
          cascade_stores: affectedStores.length,
        })],
      );

      return json(res, {
        success: true,
        mode: 'delete',
        target_user_id,
        warning: `App profile deleted and ${affectedStores.length} store(s) soft-deleted, but auth user could not be removed: ${authErrorMsg}.`,
      });
    }

    await ctx.q(
      `INSERT INTO public.admin_audit_logs (action, target_user_id, performed_by, details) VALUES ($1,$2,$3,$4)`,
      ['delete_user', target_user_id, ctx.userId, JSON.stringify({
        result: 'success',
        profile_status: 'deleted',
        auth_deleted: true,
        cascade_stores_soft_deleted: affectedStores.length,
      })],
    );

    return json(res, {
      success: true,
      mode: 'delete',
      target_user_id,
      auth_deleted: true,
      cascade_stores_soft_deleted: affectedStores.length,
    });
  } catch (err) {
    return json(res, { error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
}
