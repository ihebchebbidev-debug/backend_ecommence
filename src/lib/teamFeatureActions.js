import { badRequest, forbidden } from './errors.js';

export const SUBSCRIPTION_FIELDS = ['plan_code', 'billing_cycle', 'pending_plan_code', 'period_end', 'cycle_start', 'cycle_end', 'quota_usd', 'used_usd', 'remaining_usd', 'unpaid_commission_usd', 'unpaid_overage_usd', 'paid_commission_usd', 'hidden_orders'];

export async function memberSubscription({ p_store_id }, ctx) {
  const row = await ctx.one('SELECT public.plan_overview($1) AS v', [p_store_id]);
  return Object.fromEntries(SUBSCRIPTION_FIELDS.map(key => [key, row?.v?.[key] ?? null]));
}

export async function memberAutomations({ p_store_id }, ctx) {
  return { automations: await ctx.q(`SELECT id, name, trigger_event, channel, active, created_at, updated_at
    FROM public.store_automations WHERE store_id=$1 ORDER BY created_at, id`, [p_store_id]) };
}

export async function memberAutomationToggle({ p_store_id, p_id, p_active }, ctx) {
  if (typeof p_active !== 'boolean') throw badRequest('Invalid active flag');
  return ctx.tx(async t => {
    const row = await t.one('UPDATE public.store_automations SET active=$3, updated_at=now() WHERE store_id=$1 AND id=$2 RETURNING id, active', [p_store_id, p_id, p_active]);
    if (!row) throw forbidden('Automation not found in this shop');
    return row;
  });
}

export async function memberAutomationDelete({ p_store_id, p_id }, ctx) {
  return ctx.tx(async t => {
    const row = await t.one('DELETE FROM public.store_automations WHERE store_id=$1 AND id=$2 RETURNING id', [p_store_id, p_id]);
    if (!row) throw forbidden('Automation not found in this shop');
    return { id: row.id, deleted: true };
  });
}

const OFFER_GROUPS = ['volume', 'gift_boxes', 'bxgy'];
function readOffers(value) {
  try { const v = typeof value === 'string' ? JSON.parse(value) : value; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { throw badRequest('Invalid saved offers'); }
}
export async function memberOffers({ p_store_id }, ctx) {
  const cfg = readOffers((await ctx.one("SELECT value FROM public.store_settings WHERE store_id=$1 AND key='sell_more'", [p_store_id]))?.value);
  return { offers: OFFER_GROUPS.flatMap(group => (Array.isArray(cfg[group]) ? cfg[group] : []).map(o => ({ id: o.id, name: o.name, group, active: o.active !== false }))) };
}
async function changeOffer({ p_store_id, p_id, p_group, p_active }, ctx, remove) {
  if (!OFFER_GROUPS.includes(p_group) || typeof p_id !== 'string' || !p_id || (!remove && typeof p_active !== 'boolean')) throw badRequest('Invalid offer action');
  return ctx.tx(async t => {
    // The shared settings row is locked: changing one offer cannot overwrite a concurrent edit.
    const row = await t.one("SELECT value FROM public.store_settings WHERE store_id=$1 AND key='sell_more' FOR UPDATE", [p_store_id]);
    const cfg = readOffers(row?.value);
    const list = Array.isArray(cfg[p_group]) ? cfg[p_group] : [];
    if (!list.some(o => o.id === p_id)) throw forbidden('Offer not found in this shop');
    cfg[p_group] = remove ? list.filter(o => o.id !== p_id) : list.map(o => o.id === p_id ? { ...o, active: p_active } : o);
    await t.q("UPDATE public.store_settings SET value=$2 WHERE store_id=$1 AND key='sell_more'", [p_store_id, JSON.stringify(cfg)]);
    return { id: p_id, ...(remove ? { deleted: true } : { active: p_active }) };
  });
}
export const memberOfferToggle = (args, ctx) => changeOffer(args, ctx, false);
export const memberOfferDelete = (args, ctx) => changeOffer(args, ctx, true);

export async function memberDelivery({ p_store_id }, ctx) {
  const locked = await ctx.one('SELECT customer_data_locked FROM public.store_subscriptions WHERE store_id=$1 ORDER BY created_at DESC LIMIT 1', [p_store_id]);
  // Fail closed on unavailable billing privacy state; never expose carrier raw payloads.
  const visible = locked?.customer_data_locked === false;
  const rows = await ctx.q(`SELECT ds.id, ds.store_id, ds.order_id, o.order_number::text,
    ds.provider_code, dp.name AS provider_name, ds.tracking_number, ds.status AS delivery_status,
    sdi.delivery_cost_tnd, sdi.return_cost_tnd,
    CASE WHEN $2 THEN o.client_name ELSE NULL END AS client_name,
    CASE WHEN $2 THEN o.region ELSE NULL END AS region, ds.created_at
    FROM public.delivery_shipments ds JOIN public.orders o ON o.id=ds.order_id AND o.store_id=ds.store_id
    LEFT JOIN public.delivery_providers dp ON dp.id=ds.provider_id
    LEFT JOIN public.store_delivery_integrations sdi ON sdi.store_id=ds.store_id AND sdi.provider_code=ds.provider_code
    WHERE ds.store_id=$1 AND o.deleted_at IS NULL ORDER BY ds.created_at DESC, ds.id`, [p_store_id, visible]);
  return rows;
}

export async function memberStoreSave({ p_store_id, p_name }, ctx) {
  if (typeof p_name !== 'string' || !p_name.trim() || p_name.trim().length > 120) throw badRequest('Invalid shop name');
  return ctx.tx(async t => {
    const row = await t.one('UPDATE public.platform_stores SET store_name=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id, store_name', [p_store_id, p_name.trim()]);
    if (!row) throw forbidden('Shop unavailable');
    return row;
  });
}