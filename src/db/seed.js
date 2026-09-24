// Startup seed: default plans + super-admin promotion. Idempotent.
import { pool } from '../db.js';

const PLANS = [
  { code: 'starter', name: 'Starter', price: 0, tier: 0, fee: 0.3 },
  { code: 'pro', name: 'Pro', price: 59, tier: 1, fee: 0 },
  { code: 'business', name: 'Business', price: 159, tier: 2, fee: 0 },
  { code: 'business_plus', name: 'Business Plus', price: 490, tier: 3, fee: 0 },
];

export async function seed(log) {
  const run = (sql, p) => pool.query(sql, p).catch((e) => log.warn('seed step failed', { message: e.message }));
  for (const p of PLANS) {
    await run(
      `INSERT INTO public.plans (code,name,price,price_tnd,currency,currency_display,currency_payment,tier,per_order_fee_tnd,is_active)
       SELECT $1,$2,$3,$3,'TND','TND','TND',$4,$5,true
        WHERE NOT EXISTS (SELECT 1 FROM public.plans WHERE code = $1)`,
      [p.code, p.name, p.price, p.tier, p.fee],
    );
    await run(
      `INSERT INTO public.subscription_plans (name,price_monthly,price_yearly,is_active)
       SELECT $1,$2,$2*10,true
        WHERE NOT EXISTS (SELECT 1 FROM public.subscription_plans
                           WHERE regexp_replace(lower(name),'[^a-z0-9]+','_','g') = $3)`,
      [p.name, p.price, p.code],
    );
  }
  // Promote configured admin emails (account must already exist).
  const emails = (process.env.SUPER_ADMIN_EMAILS || 'admin@e-commence.shop')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  await run(
    `INSERT INTO public.admin_roles (user_id,email,role)
     SELECT id, email, 'super_admin' FROM auth.users WHERE lower(email) = ANY($1)
     ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin'`,
    [emails],
  );
  // Backfill plan links for stores created while plans were missing.
  await run(`UPDATE public.store_subscriptions ss SET plan_id = sp.id
               FROM public.platform_stores s, public.subscription_plans sp
              WHERE ss.store_id = s.id AND ss.plan_id IS NULL
                AND regexp_replace(lower(sp.name),'[^a-z0-9]+','_','g') = lower(s.subscription_plan)`);
  await run(`UPDATE public.platform_stores s SET plan_id = sp.id
               FROM public.subscription_plans sp
              WHERE s.plan_id IS NULL
                AND regexp_replace(lower(sp.name),'[^a-z0-9]+','_','g') = lower(s.subscription_plan)`);
}
