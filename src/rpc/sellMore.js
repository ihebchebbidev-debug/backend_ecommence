// Public sell-more endpoints: shopper photo reviews and the thank-you page upsell.
import { badRequest, forbidden } from '../lib/errors.js';
import { id, text, phone, rateLimit, publicStore, money, major } from '../lib/commerce.js';
import { loadSellMore } from '../lib/offers.js';

const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export default {
  /** submit_product_review(p_store_id, p_product_id, p_name, p_rating, p_comment, p_photos[], p_city) → { id, status } */
  async submit_product_review({ p_store_id, p_product_id, p_name, p_rating, p_comment, p_photos = [], p_city = '' }, ctx) {
    await publicStore(ctx, p_store_id);
    await rateLimit(ctx, 'review', id(p_store_id), 5);
    const product = await ctx.one('SELECT id FROM public.products WHERE id=$1 AND store_id=$2', [id(p_product_id), p_store_id]);
    if (!product) throw badRequest('Product unavailable');
    const rating = Number(p_rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('Invalid rating');
    const name = text(p_name, 80, true);
    const comment = text(p_comment, 2000, true);
    if (!Array.isArray(p_photos) || p_photos.length > 3) throw badRequest('Up to 3 photos');
    // Photos arrive already resized by the browser; cap each at ~350 KB.
    const photos = p_photos.map(ph => {
      if (typeof ph !== 'string' || ph.length > 480000 || !PHOTO.test(ph)) throw badRequest('Invalid photo');
      return ph;
    });
    const cfg = await loadSellMore(ctx, p_store_id);
    const status = cfg?.reviews?.auto_approve ? 'published' : 'pending';
    const row = await ctx.one(
      `INSERT INTO public.product_reviews (product_id, store_id, customer_name, customer_city, rating, comment, image_url, photos, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,0) RETURNING id, status`,
      [product.id, p_store_id, name, text(p_city, 80), rating, comment, photos[0] || null, JSON.stringify(photos), status],
    );
    return row;
  },

  /** add_thank_you_upsell(p_store_id, p_order_id, p_offer_id, p_phone) → { total, added } */
  async add_thank_you_upsell({ p_store_id, p_order_id, p_offer_id, p_phone }, ctx) {
    await publicStore(ctx, p_store_id);
    await rateLimit(ctx, 'ty-upsell', id(p_store_id), 10);
    const tel = phone(p_phone);
    return ctx.tx(async (t) => {
      const order = await t.one(
        `SELECT id, amount::text, currency, client_phone, status, created_at, upsell_added_at, merchandise_subtotal::text
           FROM public.orders WHERE id=$1 AND store_id=$2 FOR UPDATE`, [id(p_order_id), p_store_id]);
      if (!order) throw forbidden('Order unavailable');
      const ownPhone = phone(order.client_phone || '0');
      if (ownPhone !== tel) throw forbidden('Order unavailable');
      if (order.status !== 'pending' || order.upsell_added_at) throw badRequest('Offer no longer available', { code: 'UPSELL_CLOSED' });
      if (Date.now() - new Date(order.created_at).getTime() > 30 * 60 * 1000) throw badRequest('Offer expired', { code: 'UPSELL_CLOSED' });
      const offer = await t.one(
        `SELECT o.id, o.name, o.discount_percent::text, p.id AS product_id, p.name AS product_name, p.price::text, p.stock
           FROM public.store_upsell_offers o JOIN public.products p ON p.id=o.offer_product_id AND p.store_id=o.store_id
          WHERE o.id=$1 AND o.store_id=$2 AND o.active=true AND o.type='thank_you' FOR UPDATE OF p`, [id(p_offer_id), p_store_id]);
      if (!offer) throw badRequest('Offer unavailable');
      if (offer.stock != null && offer.stock < 1) throw badRequest('Insufficient stock', { code: 'OUT_OF_STOCK' });
      const cur = order.currency || 'TND';
      const priceMinor = money(offer.price, cur);
      const discMinor = Math.round(priceMinor * Math.min(100, Number(offer.discount_percent) || 0) / 100);
      const lineMinor = priceMinor - discMinor;
      await t.q(
        `INSERT INTO public.order_items (order_id, product_id, product_name, quantity, unit_price, line_total, delivery_fee, discount_amount)
         VALUES ($1,$2,$3,1,$4,$5,0,$6)`,
        [order.id, offer.product_id, offer.product_name, major(priceMinor, cur), major(lineMinor, cur), major(discMinor, cur)],
      );
      if (offer.stock != null) await t.q('UPDATE public.products SET stock=stock-1 WHERE id=$1', [offer.product_id]);
      const total = major(money(order.amount, cur) + lineMinor, cur);
      await t.q(
        `UPDATE public.orders SET amount=$2, merchandise_subtotal=coalesce(merchandise_subtotal,0)+$3, upsell_added_at=now(), updated_at=now() WHERE id=$1`,
        [order.id, total, major(priceMinor, cur)],
      );
      await t.q('UPDATE public.store_upsell_offers SET conversions=conversions+1, revenue=revenue+$2 WHERE id=$1', [offer.id, major(lineMinor, cur)]);
      return { total, added: { name: offer.product_name, price: major(lineMinor, cur) } };
    });
  },
};
