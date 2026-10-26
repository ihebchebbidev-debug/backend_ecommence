// Mobile catalogue editor: product options (variants) and category, saved atomically.
// Seller-only (canManageProducts); the product and category must belong to the shop.
import { badRequest, notFound } from '../lib/errors.js';
import { id, permission, text } from '../lib/commerce.js';

const MAX_OPTIONS = 20, MAX_VALUES = 50;

/** Validates the option list sent by the app; throws on anything malformed. */
export function cleanOptions(input) {
  if (!Array.isArray(input) || input.length > MAX_OPTIONS) throw badRequest('Invalid options');
  const seen = new Set();
  return input.map((o, index) => {
    if (!o || typeof o !== 'object') throw badRequest('Invalid option');
    const name = text(o.name, 80, true);
    const key = name.toLowerCase();
    if (seen.has(key)) throw badRequest('Duplicate option name');
    seen.add(key);
    const type = o.type == null ? 'text' : text(o.type, 20, true);
    if (!Array.isArray(o.values) || o.values.length > MAX_VALUES) throw badRequest('Invalid option values');
    const values = [...new Set(o.values.map(v => text(v, 80, true)))];
    return { id: o.id == null ? null : id(o.id), name, type, values, sort_order: index };
  });
}

export default {
  async mobile_save_product_catalog(args, ctx) {
    const storeId = id(args.p_store_id), productId = id(args.p_product_id);
    await permission(ctx, storeId, 'canManageProducts');
    const options = cleanOptions(args.p_options ?? []);
    const categoryId = args.p_category_id == null || args.p_category_id === '' ? null : id(args.p_category_id);
    return ctx.tx(async t => {
      const product = await t.one('SELECT id FROM public.products WHERE id=$1 AND store_id=$2 AND deleted_at IS NULL FOR UPDATE', [productId, storeId]);
      if (!product) throw notFound('Product not found');
      if (categoryId && !(await t.one('SELECT id FROM public.categories WHERE id=$1 AND store_id=$2', [categoryId, storeId]))) throw badRequest('Category not in shop');
      await t.q('UPDATE public.products SET category_id=$3, updated_at=now() WHERE id=$1 AND store_id=$2', [productId, storeId, categoryId]);
      const keep = options.filter(o => o.id).map(o => o.id);
      await t.q('DELETE FROM public.product_options WHERE product_id=$1 AND NOT (id = ANY($2::uuid[]))', [productId, keep]);
      for (const o of options) {
        if (o.id) {
          const row = await t.one(`UPDATE public.product_options SET name=$3,type=$4,values=$5::jsonb,sort_order=$6,updated_at=now() WHERE id=$1 AND product_id=$2 RETURNING id`,
            [o.id, productId, o.name, o.type, JSON.stringify(o.values), o.sort_order]);
          if (!row) throw badRequest('Option not in product');
        } else {
          await t.q('INSERT INTO public.product_options(product_id,name,type,values,sort_order) VALUES ($1,$2,$3,$4::jsonb,$5)',
            [productId, o.name, o.type, JSON.stringify(o.values), o.sort_order]);
        }
      }
      const saved = await t.q('SELECT id,name,type,values,sort_order FROM public.product_options WHERE product_id=$1 ORDER BY sort_order', [productId]);
      return { product_id: productId, category_id: categoryId, options: saved };
    });
  },
};
