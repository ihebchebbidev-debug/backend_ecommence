import { ALL_PLANS_UNLOCKED } from './billing.js';
// SQL RPC functions: orders (spec 3.3).
import { createHash } from 'node:crypto';
import { badRequest, forbidden } from '../lib/errors.js';
import { id, text, couponCode, priceCheckout, major } from '../lib/commerce.js';

const ORDER_COLUMNS_SECURE = `
  o.id, o.order_number, o.client_id, o.client_name, o.client_phone, o.product_id,
  o.product_name, o.quantity, o.amount, o.delivery_fee, o.status, o.region, o.agent_id, o.agent_name,
  o.notes, o.created_at, o.updated_at, o.confirmation_status, o.callback_scheduled_at,
  o.confirmation_notes, o.confirmed_at, o.store_id, o.bundle_id, o.bundle_name,
  o.bundle_label, o.bundle_price, o.bundle_quantity, o.currency, o.order_fee_amount_usd,
  o.order_fee_charged_at, o.order_billing_status
`;

function maskName(name) {
  if (name === null || name === undefined || name === '') return '********';
  return '********';
}

function maskPhone(phone) {
  if (phone === null || phone === undefined || phone === '') return '********';
  if (typeof phone === 'string' && phone.startsWith('+216')) return '+216 ** *** ***';
  return '********';
}

function projectSecureRow(row, canView) {
  return {
    id: row.id,
    order_number: row.order_number,
    client_id: row.client_id,
    client_name: canView ? row.client_name : maskName(row.client_name),
    client_phone: canView ? row.client_phone : maskPhone(row.client_phone),
    product_id: row.product_id,
    product_name: row.product_name,
    quantity: row.quantity,
    amount: row.amount,
    delivery_fee: row.delivery_fee,
    status: row.status,
    region: row.region,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    notes: canView ? row.notes : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    confirmation_status: row.confirmation_status,
    callback_scheduled_at: row.callback_scheduled_at,
    confirmation_notes: canView ? row.confirmation_notes : null,
    confirmed_at: row.confirmed_at,
    store_id: row.store_id,
    bundle_id: row.bundle_id,
    bundle_name: row.bundle_name,
    bundle_label: row.bundle_label,
    bundle_price: row.bundle_price,
    bundle_quantity: row.bundle_quantity,
    currency: row.currency,
    order_fee_amount_usd: row.order_fee_amount_usd,
    order_fee_charged_at: row.order_fee_charged_at,
    order_billing_status: row.order_billing_status,
    customer_data_visible: canView,
  };
}

function projectListRow(row, canView) {
  return {
    ...projectSecureRow(row, canView),
    address: canView ? row.address : null,
    city: row.city,
    client_phone2: canView ? row.client_phone2 : maskPhone(row.client_phone2),
    deleted_at: row.deleted_at,
    delivery_status: row.delivery_status,
    locality_id: row.locality_id,
    payment_provider: row.payment_provider,
    payment_ref: row.payment_ref,
    payment_status: row.payment_status,
    product_image_url: row.product_image_url,
    tracking_number: row.tracking_number,
  };
}

export default {
  async get_store_orders_secure({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const canView = await ctx.canViewCustomerData(p_store_id);
    const rows = await ctx.q(
      `SELECT o.*, pr.image_url AS product_image_url
       FROM public.orders o
       LEFT JOIN public.products pr ON pr.id = o.product_id
       WHERE o.store_id = $1 AND o.deleted_at IS NULL
       ORDER BY o.created_at DESC NULLS LAST`,
      [p_store_id],
    );
    return rows.map((r) => projectListRow(r, canView));
  },

  async get_store_orders_secure_paginated(args, ctx) {
    const {
      p_store_id,
      p_status = null,
      p_search = null,
      p_date_from = null,
      p_date_to = null,
      p_limit = 50,
      p_offset = 0,
      p_include_trash = false,
    } = args;
    await ctx.assertStoreAccess(p_store_id);
    const canView = await ctx.canViewCustomerData(p_store_id);

    const conds = ['o.store_id = $1'];
    const params = [p_store_id];
    if (!p_include_trash) conds.push('o.deleted_at IS NULL');
    else conds.push('o.deleted_at IS NOT NULL');
    if (p_status) {
      params.push(p_status);
      conds.push(`o.status = $${params.length}`);
    }
    if (p_search) {
      params.push(`%${p_search}%`);
      conds.push(`(o.client_name ILIKE $${params.length} OR o.client_phone ILIKE $${params.length} OR o.order_number ILIKE $${params.length})`);
    }
    if (p_date_from) {
      params.push(p_date_from);
      conds.push(`o.created_at >= $${params.length}`);
    }
    if (p_date_to) {
      params.push(p_date_to);
      conds.push(`o.created_at <= $${params.length}`);
    }
    const where = conds.join(' AND ');

    params.push(p_limit);
    const limitIdx = params.length;
    params.push(p_offset);
    const offsetIdx = params.length;

    const rows = await ctx.q(
      `SELECT o.*, pr.image_url AS product_image_url, COUNT(*) OVER() AS total_count
       FROM public.orders o
       LEFT JOIN public.products pr ON pr.id = o.product_id
       WHERE ${where}
       ORDER BY o.created_at DESC NULLS LAST
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map((r) => ({ ...projectListRow(r, canView), total_count: r.total_count }));
  },

  async get_store_orders_counts({ p_store_id, p_date_from = null, p_date_to = null }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const conds = ['store_id = $1', 'deleted_at IS NULL'];
    const params = [p_store_id];
    if (p_date_from) {
      params.push(p_date_from);
      conds.push(`created_at >= $${params.length}`);
    }
    if (p_date_to) {
      params.push(p_date_to);
      conds.push(`created_at <= $${params.length}`);
    }
    return ctx.q(
      `SELECT status, COUNT(*)::int AS cnt FROM public.orders WHERE ${conds.join(' AND ')} GROUP BY status`,
      params,
    );
  },

  async get_store_orders_trash_count({ p_store_id, p_date_from = null, p_date_to = null }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const conds = ['store_id = $1', 'deleted_at IS NOT NULL'];
    const params = [p_store_id];
    if (p_date_from) {
      params.push(p_date_from);
      conds.push(`created_at >= $${params.length}`);
    }
    if (p_date_to) {
      params.push(p_date_to);
      conds.push(`created_at <= $${params.length}`);
    }
    return ctx.q(
      `SELECT COUNT(*)::int AS cnt FROM public.orders WHERE ${conds.join(' AND ')}`,
      params,
    );
  },

  async get_store_orders_phone_prediction({ p_store_id, p_order_ids = null }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const params = [p_store_id];
    let orderFilter = '';
    if (p_order_ids && p_order_ids.length) {
      params.push(p_order_ids);
      orderFilter = `AND o.id = ANY($${params.length}::uuid[])`;
    }
    const rows = await ctx.q(
      `SELECT o.id AS order_id, o.client_phone
       FROM public.orders o
       WHERE o.store_id = $1 ${orderFilter}`,
      params,
    );
    const out = [];
    for (const r of rows) {
      const phone = r.client_phone;
      const stats = await ctx.one(
        `SELECT COUNT(*)::int AS phone_orders,
                COUNT(*) FILTER (WHERE status = 'confirmed')::int AS phone_confirmed,
                COUNT(*) FILTER (WHERE status = 'delivered')::int AS phone_delivered
         FROM public.orders WHERE store_id = $1 AND client_phone = $2`,
        [p_store_id, phone],
      );
      const phoneOrders = stats?.phone_orders ?? 0;
      const phoneConfirmed = stats?.phone_confirmed ?? 0;
      const phoneDelivered = stats?.phone_delivered ?? 0;
      out.push({
        order_id: r.order_id,
        phone_orders: phoneOrders,
        phone_confirmed: phoneConfirmed,
        phone_delivered: phoneDelivered,
        confirmation_rate: phoneOrders ? phoneConfirmed / phoneOrders : 0,
        delivery_rate: phoneOrders ? phoneDelivered / phoneOrders : 0,
      });
    }
    return out;
  },

  async get_store_orders_trust({ p_store_id, p_order_ids = null }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const params = [p_store_id];
    let orderFilter = '';
    if (p_order_ids && p_order_ids.length) {
      params.push(p_order_ids);
      orderFilter = `AND o.id = ANY($${params.length}::uuid[])`;
    }
    const rows = await ctx.q(
      `SELECT o.id AS order_id, o.client_phone
       FROM public.orders o
       WHERE o.store_id = $1 ${orderFilter}`,
      params,
    );
    const out = [];
    for (const r of rows) {
      const phone = r.client_phone;
      const stats = await ctx.one(
        `SELECT COUNT(*)::int AS total_orders,
                COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
                COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
                COUNT(*) FILTER (WHERE status = 'returned')::int AS returned
         FROM public.orders WHERE store_id = $1 AND client_phone = $2`,
        [p_store_id, phone],
      );
      const total = stats?.total_orders ?? 0;
      const delivered = stats?.delivered ?? 0;
      out.push({
        order_id: r.order_id,
        total_orders: total,
        delivered,
        rejected: stats?.rejected ?? 0,
        returned: stats?.returned ?? 0,
        score: total ? delivered / total : 0,
      });
    }
    return out;
  },

  async get_order_secure({ p_order_id }, ctx) {
    const order = await ctx.one('SELECT store_id FROM public.orders WHERE id = $1', [p_order_id]);
    if (!order) return [];
    await ctx.assertStoreAccess(order.store_id);
    const canView = await ctx.canViewCustomerData(order.store_id);
    const row = await ctx.one(`SELECT o.* FROM public.orders o WHERE o.id = $1`, [p_order_id]);
    if (!row) return [];
    const items = await ctx.q(
      `SELECT id, product_id, product_name, bundle_id, bundle_name, bundle_label,
              bundle_price, bundle_quantity, quantity, unit_price, line_total, delivery_fee
       FROM public.order_items WHERE order_id = $1 ORDER BY created_at, id`,
      [p_order_id],
    );
    return [{ ...projectSecureRow(row, canView), items }];
  },

  async get_order_items({ p_order_id }, ctx) {
    const order = await ctx.one('SELECT store_id FROM public.orders WHERE id = $1', [p_order_id]);
    if (!order) return [];
    await ctx.assertStoreAccess(order.store_id);
    return ctx.q(
      `SELECT id, order_id, product_id, product_name, bundle_id, bundle_name, bundle_label,
              bundle_price, bundle_quantity, quantity, unit_price, line_total, delivery_fee, created_at
       FROM public.order_items WHERE order_id = $1 ORDER BY created_at, id`,
      [p_order_id],
    );
  },

  async create_public_order(args, ctx) {
    const {
      p_store_id,
      p_client,
      p_items,
      p_currency = 'TND',
      p_payment_provider = null,
      p_payment_method = null,
      p_coupon_code = '',
      p_checkout_request_id = null,
    } = args;

    id(p_store_id);
    const requestId = p_checkout_request_id == null ? null : id(p_checkout_request_id);
    const client = {
      name: text(p_client?.name, 120),
      phone: text(p_client?.phone, 32),
      phone2: text(p_client?.phone2, 32),
      email: text(p_client?.email, 255),
      address: text(p_client?.address, 500),
      city: text(p_client?.city, 120),
      region: text(p_client?.region ?? p_client?.governorate, 120),
      notes: text(p_client?.notes, 1000),
    };
    if (!Array.isArray(p_items) || p_items.length === 0) throw badRequest('La commande doit contenir au moins un article');
    // Bundle lines default to one bundle; legacy `quantity` there meant pieces.
    const items = p_items.map((i) => ({ ...i, bundle_count: i?.bundle_id ? (i.bundle_count ?? 1) : undefined }));
    const code = couponCode(p_coupon_code);
    const fingerprint = createHash('sha256').update(JSON.stringify([items, code, client.phone])).digest('hex');

    return ctx.tx(async (t) => {
      // Serialize per shop: order numbers, coupon caps and stock stay consistent.
      await t.one('SELECT id FROM public.platform_stores WHERE id = $1 FOR UPDATE', [p_store_id]);
      if (requestId) {
        const prior = await t.one('SELECT id, order_number, amount, checkout_fingerprint FROM public.orders WHERE store_id=$1 AND checkout_request_id=$2', [p_store_id, requestId]);
        if (prior) {
          if (prior.checkout_fingerprint !== fingerprint) throw badRequest('Checkout request reused with different content', { code: 'CHECKOUT_CONFLICT' });
          return [{ order_id: prior.id, order_number: prior.order_number, total: prior.amount }];
        }
      }

      const quote = await priceCheckout(t, p_store_id, items, p_currency, code, true);
      if (code) {
        const plan = await t.one(`SELECT coalesce(o.is_enabled,pl.has_coupons,false) AS allowed FROM public.platform_stores s
          LEFT JOIN public.store_feature_overrides o ON o.store_id=s.id AND o.feature_key='has_coupons'
          LEFT JOIN LATERAL (SELECT has_coupons FROM public.plan_limits WHERE plan_id=s.plan_id OR plan=s.subscription_plan ORDER BY (plan_id=s.plan_id) DESC LIMIT 1) pl ON true WHERE s.id=$1`, [p_store_id]);
        if (!ALL_PLANS_UNLOCKED && !plan?.allowed) throw badRequest('Coupon unavailable', { code: 'COUPON_INVALID' });
      }

      let clientRow = null;
      if (client.phone) clientRow = await t.one('SELECT id FROM public.clients WHERE store_id = $1 AND phone = $2 LIMIT 1', [p_store_id, client.phone]);
      if (!clientRow) {
        clientRow = await t.one(
          `INSERT INTO public.clients (store_id, name, phone, email, city, region, note)
           VALUES ($1, $2, $3, $4, $5, $6, '') RETURNING id`,
          [p_store_id, client.name, client.phone, client.email, client.city, client.region],
        );
      }

      const seq = await t.one(
        `INSERT INTO public.store_order_seq (store_id, next_val) VALUES ($1, 1)
         ON CONFLICT (store_id) DO UPDATE SET next_val = public.store_order_seq.next_val + 1
         RETURNING next_val`,
        [p_store_id],
      );
      const orderNumber = String(seq.next_val).padStart(5, '0');
      const first = quote.rows[0];

      const order = await t.one(
        `INSERT INTO public.orders (
           store_id, order_number, client_id, client_name, client_phone, client_phone2,
           product_id, product_name, quantity, amount, delivery_fee, currency, status,
           bundle_id, bundle_name, bundle_label, bundle_price, bundle_quantity,
           payment_provider, address, city, region, merchandise_subtotal, discount_amount,
           coupon_code, checkout_request_id, checkout_fingerprint, notes, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27, now(), now())
         RETURNING id, order_number, amount`,
        [
          p_store_id, orderNumber, clientRow.id, client.name, client.phone, client.phone2,
          first.product.id, first.product.name, first.qty, quote.total, quote.delivery, p_currency,
          first.bundle?.id || null, first.bundle?.name || null, first.bundle?.label || null,
          first.bundlePrice, first.bundle?.quantity || null,
          text(p_payment_provider || p_payment_method || '', 60),
          client.address, client.city, client.region,
          quote.subtotal, quote.discount, quote.coupon ? code : null, requestId, fingerprint,
          client.notes,
        ],
      );

      for (const r of quote.rows) {
        await t.q(
          `INSERT INTO public.order_items (
             order_id, product_id, product_name, bundle_id, bundle_name, bundle_label,
             bundle_price, bundle_quantity, quantity, unit_price, line_total, delivery_fee, discount_amount
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            order.id, r.product.id, r.product.name, r.bundle?.id || null, r.bundle?.name || null,
            r.bundle?.label || null, r.bundlePrice, r.bundle?.quantity || null,
            r.qty, r.unitPrice, r.lineTotal, r.deliveryFee, major(r.discountMinor, p_currency),
          ],
        );
      }

      // Reserve finite inventory (rows already locked by priceCheckout).
      for (const { product, required } of quote.stock.values()) {
        if (product.stock != null) await t.q('UPDATE public.products SET stock = stock - $2 WHERE id = $1', [product.id, required]);
      }

      // Immutable snapshot of the shop offers applied, plus upsell performance counters.
      if (quote.offers.length) {
        await t.q('UPDATE public.orders SET offer_discount=$2, offer_snapshot=$3::jsonb WHERE id=$1', [order.id, quote.offerDiscount, JSON.stringify(quote.offers)]);
        for (const o of quote.offers.filter(x => x.type === 'upsell')) {
          await t.q('UPDATE public.store_upsell_offers SET conversions=conversions+1, revenue=revenue+$3 WHERE id=$1 AND store_id=$2', [o.id, p_store_id, quote.rows.filter(r => r.item?.upsell_offer_id === o.id).reduce((s, r) => s + major(r.lineMinor - r.offerMinor, p_currency), 0)]);
        }
      }

      if (quote.coupon) {
        await t.q('UPDATE public.coupons SET used_count = used_count + 1 WHERE id = $1', [quote.coupon.id]);
        await t.q(
          'INSERT INTO public.coupon_redemptions (order_id, coupon_id, store_id, code, discount_amount) VALUES ($1,$2,$3,$4,$5)',
          [order.id, quote.coupon.id, p_store_id, code, quote.discount],
        );
      }

      return [{ order_id: order.id, order_number: order.order_number, total: order.amount }];
    });
  },

  async soft_delete_store_order({ p_order_id }, ctx) {
    const order = await ctx.one('SELECT store_id FROM public.orders WHERE id = $1', [p_order_id]);
    if (!order) return false;
    await ctx.assertStoreAccess(order.store_id);
    const res = await ctx.one(
      `UPDATE public.orders SET deleted_at = now() WHERE id = $1 RETURNING id`,
      [p_order_id],
    );
    return !!res;
  },

  async restore_store_order({ p_order_id }, ctx) {
    const order = await ctx.one('SELECT store_id FROM public.orders WHERE id = $1', [p_order_id]);
    if (!order) return false;
    await ctx.assertStoreAccess(order.store_id);
    const res = await ctx.one(
      `UPDATE public.orders SET deleted_at = NULL WHERE id = $1 RETURNING id`,
      [p_order_id],
    );
    return !!res;
  },

  async next_store_order_number({ p_store_id }, ctx) {
    await ctx.assertStoreAccess(p_store_id);
    const seq = await ctx.one(
      `INSERT INTO public.store_order_seq (store_id, next_val) VALUES ($1, 1)
       ON CONFLICT (store_id) DO UPDATE SET next_val = public.store_order_seq.next_val + 1
       RETURNING next_val`,
      [p_store_id],
    );
    return String(seq.next_val).padStart(5, '0');
  },

  async guard_order_store_id({ p_store_id }, ctx) {
    const store = await ctx.one(
      'SELECT store_name, status, quarantine_reason, deleted_at FROM public.platform_stores WHERE id = $1',
      [p_store_id],
    );
    if (!store) return [{ valid: false, store_name: null, quarantine_reason: null }];
    const valid = store.status === 'active' && !store.deleted_at;
    return [{ valid, store_name: store.store_name, quarantine_reason: store.quarantine_reason || null }];
  },

  async store_accepts_public_orders({ p_store_id }, ctx) {
    const store = await ctx.one(
      'SELECT status, deleted_at FROM public.platform_stores WHERE id = $1',
      [p_store_id],
    );
    if (!store) return false;
    return store.status === 'active' && !store.deleted_at;
  },
};
