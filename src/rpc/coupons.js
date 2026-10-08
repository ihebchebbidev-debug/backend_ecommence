import { ALL_PLANS_UNLOCKED } from './billing.js';
import { badRequest, forbidden, conflict } from '../lib/errors.js';
import billing from './billing.js';
import { id, permission, couponCode, boundedInt, priceCheckout, rateLimit, money } from '../lib/commerce.js';

async function entitled(ctx,storeId) {
  if (!(await billing.plan_allows({p_store_id:storeId,p_feature_key:'has_coupons'},ctx))) throw forbidden('Plan does not allow coupons',{code:'PLAN_LIMIT_REACHED'});
}
function definition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Invalid coupon');
  const code=couponCode(value.code);
  if (!code || !['fixed','percentage'].includes(value.type) || typeof value.active !== 'boolean') throw badRequest('Invalid coupon');
  const amount=Number(value.value);
  const minimum=Number(value.min_order_amount ?? 0);
  if (!Number.isFinite(amount) || amount<=0 || amount>1000000 || (value.type==='percentage' && amount>100) || !Number.isFinite(minimum) || minimum<0 || minimum>1000000) throw badRequest('Invalid coupon value');
  const starts=value.starts_at ?? null, expires=value.expires_at ?? null;
  for (const date of [starts,expires]) if (date!=null && (typeof date!=='string' || !Number.isFinite(Date.parse(date)))) throw badRequest('Invalid coupon date');
  if (starts && expires && Date.parse(expires)<=Date.parse(starts)) throw badRequest('Expiry must follow start');
  if (value.max_uses!=null) boundedInt(value.max_uses,1,100000000);
  return {code,type:value.type,value:amount,min_order_amount:minimum,active:value.active,starts_at:starts,expires_at:expires,max_uses:value.max_uses ?? null};
}
export default {
  async list_store_coupons({p_store_id,p_limit=50,p_offset=0},ctx) {
    await permission(ctx,p_store_id,'canManageCoupons');
    boundedInt(p_limit,50);
    if (!Number.isInteger(p_offset) || p_offset<0 || p_offset>100000) throw badRequest('Invalid offset');
    return ctx.q('SELECT *,count(*) OVER() AS total_count FROM public.coupons WHERE store_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',[p_store_id,p_limit,p_offset]);
  },
  async save_store_coupon({p_store_id,p_coupon_id=null,p_coupon},ctx) {
    await permission(ctx,p_store_id,'canManageCoupons');
    await entitled(ctx,p_store_id);
    const d=definition(p_coupon);
    if (p_coupon_id) id(p_coupon_id);
    return ctx.tx(async t=>{
      await t.one('SELECT id FROM public.platform_stores WHERE id=$1 FOR UPDATE',[p_store_id]);
      const txCtx={...ctx,q:t.q,one:t.one};
      await entitled(txCtx,p_store_id);
      const existing=p_coupon_id ? await t.one('SELECT id,used_count FROM public.coupons WHERE id=$1 AND store_id=$2 FOR UPDATE',[p_coupon_id,p_store_id]) : null;
      if (p_coupon_id && !existing) throw forbidden('Coupon unavailable');
      if (existing && d.max_uses!=null && d.max_uses<existing.used_count) throw badRequest('Usage cap is below existing redemptions');
      if (!existing) {
        const max=await billing.plan_limit({p_store_id,p_limit_key:'max_coupons'},txCtx);
        const count=await t.one('SELECT count(*)::int AS count FROM public.coupons WHERE store_id=$1',[p_store_id]);
        if (max==null || (max>0 && count.count>=max)) throw forbidden('Coupon limit reached',{code:'PLAN_LIMIT_REACHED'});
      }
      const duplicate=await t.one('SELECT id FROM public.coupons WHERE store_id=$1 AND upper(trim(code))=$2 AND ($3::uuid IS NULL OR id<>$3) LIMIT 1',[p_store_id,d.code,p_coupon_id]);
      if (duplicate) throw conflict('Coupon code already exists');
      const values=[p_store_id,d.code,d.type,d.value,d.active,d.min_order_amount,d.starts_at,d.expires_at,d.max_uses];
      return existing ? t.one(`UPDATE public.coupons SET code=$2,type=$3,value=$4,active=$5,min_order_amount=$6,starts_at=$7,expires_at=$8,max_uses=$9 WHERE store_id=$1 AND id=$10 RETURNING *`,[...values,p_coupon_id]) : t.one(`INSERT INTO public.coupons(store_id,code,type,value,active,min_order_amount,starts_at,expires_at,max_uses) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,values);
    });
  },
  async set_store_coupon_active({p_store_id,p_coupon_id,p_active},ctx) {
    await permission(ctx,p_store_id,'canManageCoupons');
    if (typeof p_active!=='boolean') throw badRequest('Invalid active state');
    if (p_active) await entitled(ctx,p_store_id);
    const row=await ctx.one('UPDATE public.coupons SET active=$3 WHERE id=$1 AND store_id=$2 RETURNING *',[id(p_coupon_id),p_store_id,p_active]);
    if (!row) throw forbidden('Coupon unavailable');
    return row;
  },
  async quote_public_checkout({p_store_id,p_items,p_currency='TND',p_coupon_code=''},ctx) {
    await rateLimit(ctx,'quote',id(p_store_id));
    const code=couponCode(p_coupon_code);
    const quote=await priceCheckout(ctx,p_store_id,p_items,p_currency,code);
    if (code) {
      // Public path must check the same plan data, without demanding a seller session.
      const plan=await ctx.one(`SELECT coalesce(o.is_enabled,pl.has_coupons,false) AS allowed FROM public.platform_stores s
        LEFT JOIN public.store_feature_overrides o ON o.store_id=s.id AND o.feature_key='has_coupons'
        LEFT JOIN LATERAL (SELECT has_coupons FROM public.plan_limits WHERE plan_id=s.plan_id OR plan=s.subscription_plan ORDER BY (plan_id=s.plan_id) DESC LIMIT 1) pl ON true WHERE s.id=$1`,[p_store_id]);
      if (!ALL_PLANS_UNLOCKED && !plan?.allowed) throw badRequest('Coupon unavailable',{code:'COUPON_INVALID'});
    }
    return {subtotal:quote.subtotal,discount:quote.discount,offer_discount:quote.offerDiscount,offers:quote.offers,delivery:quote.delivery,total:quote.total,currency:p_currency,coupon_code:code || null};
  },
};
