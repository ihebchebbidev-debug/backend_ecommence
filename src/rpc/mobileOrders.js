// Mobile order operations: edit, status, history and preparation.
// Every write checks the shop + permission, runs in one transaction, records the
// actor for the order_events trigger and is protected against duplicate taps.
import { badRequest, forbidden, ApiError } from '../lib/errors.js';
import { id, permission, publicStore, text } from '../lib/commerce.js';
import { loadSession, need, CONFIRMATION_STATUSES } from './agents.js';
import { normalizeScanCode } from './mobile.js';

export const SELLER_STATUSES = ['pending', 'confirmed', 'attempt1', 'attempt2', 'transit', 'delivered', 'rejected', 'returned', 'archived'];
export const MEMBER_STATUSES = ['pending', 'confirmed', 'tentative_1', 'tentative_2', 'answered', 'wrong_number', 'attempt1', 'attempt2', 'rejected', 'shipped', 'transit', 'delivered', 'returned'];
// Orders in these states can no longer be prepared.
const NOT_PREPARABLE = ['rejected', 'returned', 'archived', 'delivered'];
const EDITABLE = ['client_name', 'client_phone', 'city', 'address', 'notes'];
const LIMITS = { client_name: 120, client_phone: 32, city: 120, address: 300, notes: 2000 };

const conflict = (message, code) => new ApiError(409, message, { code });

export function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw badRequest('Invalid idempotency key');
  return value;
}

/** Resolve the caller as a seller (JWT) or a team member (session), never both. */
export async function orderActor(args, ctx, action) {
  if (args.p_session_id != null) {
    if (ctx.userId) throw badRequest('Choose one session model');
    const session = await loadSession(ctx, id(args.p_session_id));
    need(session, 'commandes', action);
    if (args.p_store_id != null && id(args.p_store_id) !== session.store_id) throw forbidden('Shop not assigned');
    await publicStore(ctx, session.store_id);
    const sub = await ctx.one('SELECT customer_data_locked FROM public.store_subscriptions WHERE store_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [session.store_id]);
    return { storeId: session.store_id, kind: 'member', actorId: session.team_member_id, name: session.member_name,
      confirmationAgent: session.is_confirmation_agent === true, visible: sub?.customer_data_locked !== true };
  }
  const storeId = id(args.p_store_id);
  await permission(ctx, storeId, 'canManageOrders');
  await publicStore(ctx, storeId);
  return { storeId, kind: 'seller', actorId: ctx.userId, name: null, confirmationAgent: false, visible: await ctx.canViewCustomerData(storeId) };
}

export async function setActor(t, actor) {
  await t.q(`SELECT set_config('app.actor_kind',$1,true), set_config('app.actor_id',$2,true), set_config('app.actor_name',$3,true)`,
    [actor.kind, String(actor.actorId ?? ''), actor.name ?? '']);
}

/** Runs `work` once per (shop, key): a repeated call returns the first result. */
export async function once(t, storeId, key, fn, work) {
  const claimed = await t.one(`INSERT INTO public.mobile_idempotency(store_id,key,fn) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key`, [storeId, key, fn]);
  if (!claimed) {
    const prior = await t.one('SELECT fn, result FROM public.mobile_idempotency WHERE store_id=$1 AND key=$2', [storeId, key]);
    if (prior?.fn !== fn) throw badRequest('Idempotency key reused');
    return { ...prior.result, replayed: true };
  }
  const result = await work();
  await t.q('UPDATE public.mobile_idempotency SET result=$3::jsonb WHERE store_id=$1 AND key=$2', [storeId, key, JSON.stringify(result)]);
  return result;
}

function sameVersion(row, expected) {
  if (expected == null) return true;
  const current = row.updated_at ? new Date(row.updated_at).toISOString() : null;
  const wanted = expected ? new Date(expected).toISOString() : null;
  return current === wanted;
}

export function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('Invalid changes');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE.includes(key)) throw badRequest('Field not editable');
    out[key] = text(value ?? '', LIMITS[key]);
  }
  if (!Object.keys(out).length) throw badRequest('Nothing to change');
  if ('client_name' in out && !out.client_name) throw badRequest('Client name required');
  if ('client_phone' in out && !/^\+?[0-9 ()-]{6,32}$/.test(out.client_phone)) throw badRequest('Invalid phone');
  return out;
}

const RETURNING = 'id, order_number, status, client_name, client_phone, city, address, notes, amount, currency, prepared_at, prepared_by, updated_at';

export default {
  /** Edit customer details and notes, rejecting edits made on an outdated copy. */
  async mobile_order_update(args, ctx) {
    const actor = await orderActor(args, ctx, 'modify');
    const orderId = id(args.p_order_id), key = idempotencyKey(args.p_idempotency_key);
    const patch = cleanPatch(args.p_patch);
    if (!actor.visible && Object.keys(patch).some(k => k !== 'notes')) throw forbidden('Customer data locked');
    return ctx.tx(async t => once(t, actor.storeId, key, 'order_update', async () => {
      await setActor(t, actor);
      const row = await t.one('SELECT id, updated_at FROM public.orders WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL FOR UPDATE', [orderId, actor.storeId]);
      if (!row) throw forbidden('Order not found in this store');
      if (!sameVersion(row, args.p_expected_updated_at)) throw conflict('Order changed since it was opened', 'STALE_ORDER');
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
      const order = await t.one(`UPDATE public.orders SET ${sets}, updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING ${RETURNING}`, [orderId, actor.storeId, ...keys.map(k => patch[k])]);
      return { outcome: 'updated', order };
    }));
  },

  /** Change the status once per key; members follow the same allowlist as agent_update_order. */
  async mobile_order_set_status(args, ctx) {
    const actor = await orderActor(args, ctx, 'modify');
    const orderId = id(args.p_order_id), key = idempotencyKey(args.p_idempotency_key), status = args.p_status;
    const allowed = actor.kind === 'member' ? MEMBER_STATUSES : SELLER_STATUSES;
    if (!allowed.includes(status)) throw badRequest('Invalid order status');
    return ctx.tx(async t => once(t, actor.storeId, key, 'order_status', async () => {
      await setActor(t, actor);
      const row = await t.one('SELECT id, status, updated_at FROM public.orders WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL FOR UPDATE', [orderId, actor.storeId]);
      if (!row) throw forbidden('Order not found in this store');
      if (!sameVersion(row, args.p_expected_updated_at)) throw conflict('Order changed since it was opened', 'STALE_ORDER');
      if (actor.confirmationAgent && (!CONFIRMATION_STATUSES.includes(status) || !CONFIRMATION_STATUSES.includes(row.status || 'pending'))) throw forbidden('Confirmation agents can only handle orders awaiting confirmation');
      if (row.status === status) return { outcome: 'unchanged', order: await t.one(`SELECT ${RETURNING} FROM public.orders WHERE id=$1`, [orderId]) };
      const order = await t.one(`UPDATE public.orders SET status=$3,
          confirmation_status=CASE WHEN $3=ANY($4::text[]) THEN $3 ELSE confirmation_status END,
          confirmed_at=CASE WHEN $3='confirmed' THEN COALESCE(confirmed_at,now()) ELSE confirmed_at END,
          agent_id=CASE WHEN $5 THEN $6::uuid ELSE agent_id END, agent_name=CASE WHEN $5 THEN $7 ELSE agent_name END,
          updated_at=now()
        WHERE id=$1 AND store_id=$2 RETURNING ${RETURNING}`,
        [orderId, actor.storeId, status, CONFIRMATION_STATUSES, actor.kind === 'member', actor.kind === 'member' ? actor.actorId : null, actor.name]);
      return { outcome: 'updated', order };
    }));
  },

  /** Timeline of an order, newest first. Customer values are hidden under the shop lock. */
  async mobile_order_history(args, ctx) {
    const actor = await orderActor(args, ctx, 'read');
    const orderId = id(args.p_order_id);
    const exists = await ctx.one('SELECT 1 FROM public.orders WHERE id=$1 AND store_id=$2', [orderId, actor.storeId]);
    if (!exists) throw forbidden('Order not found in this store');
    const rows = await ctx.q(`SELECT id, kind, actor_kind, actor_name, changes, created_at FROM public.order_events
      WHERE store_id=$1 AND order_id=$2 ORDER BY created_at DESC, id DESC LIMIT 200`, [actor.storeId, orderId]);
    if (actor.visible) return rows;
    const hidden = ['client_name', 'client_phone', 'city', 'address', 'notes'];
    return rows.map(r => ({ ...r, changes: Object.fromEntries(Object.entries(r.changes || {}).map(([k, v]) => [k, hidden.includes(k) ? { from: null, to: null, hidden: true } : v])) }));
  },

  /**
   * Mark one exact order as prepared (packed). Never pays, ships or changes status.
   * Accepts an order id or a scanned reference; an unclear reference is refused.
   */
  async mobile_prepare_order(args, ctx) {
    const actor = await orderActor(args, ctx, 'modify');
    const key = idempotencyKey(args.p_idempotency_key);
    return ctx.tx(async t => once(t, actor.storeId, key, 'order_prepare', async () => {
      await setActor(t, actor);
      let rows;
      if (args.p_order_id != null) {
        rows = await t.q(`SELECT id, status, prepared_at FROM public.orders WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id(args.p_order_id), actor.storeId]);
      } else {
        const code = normalizeScanCode(args.p_code);
        rows = await t.q(`SELECT o.id, o.status, o.prepared_at FROM public.orders o WHERE o.store_id=$1 AND o.deleted_at IS NULL AND (
            lower(o.order_number)=lower($2) OR lower(o.tracking_number)=lower($2) OR EXISTS (
              SELECT 1 FROM public.delivery_shipments s WHERE s.store_id=$1 AND s.order_id=o.id AND lower(s.tracking_number)=lower($2)))
          ORDER BY o.id LIMIT 2 FOR UPDATE`, [actor.storeId, code]);
      }
      if (rows.length === 0) return { outcome: 'not_found' };
      if (rows.length > 1) return { outcome: 'ambiguous' };
      const row = rows[0];
      if (NOT_PREPARABLE.includes(row.status)) return { outcome: 'not_preparable', status: row.status, order_id: row.id };
      if (row.prepared_at) return { outcome: 'already_prepared', order: await t.one(`SELECT ${RETURNING} FROM public.orders WHERE id=$1`, [row.id]) };
      const order = await t.one(`UPDATE public.orders SET prepared_at=now(), prepared_by=$3, updated_at=now() WHERE id=$1 AND store_id=$2 RETURNING ${RETURNING}`,
        [row.id, actor.storeId, actor.name || (actor.kind === 'seller' ? 'owner' : 'member')]);
      return { outcome: 'prepared', order };
    }));
  },
};
