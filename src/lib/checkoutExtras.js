// Seller-configured checkout extras: custom fields and shop-wide delivery pricing.
// Shared by quote_public_checkout and create_public_order through priceCheckout, so the
// price shown to the customer and the price saved on the order are always the same.
import { badRequest } from './errors.js';

export const DELIVERY_KEYS = ['delivery_pricing', 'delivery_flat_fee', 'delivery_free_over'];
export const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'date'];

/**
 * Check the customer's answers against the shop's fields.
 * Unknown fields are dropped, required ones enforced, select values must be one of the options.
 * @returns {{ label: string, name: string, value: string }[]}
 */
export function cleanCheckoutAnswers(fields, raw) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = [];
  for (const f of fields) {
    let value = given[f.field_name];
    if (f.field_type === 'checkbox') value = value === true || value === 'true' ? 'Oui' : '';
    else value = value == null ? '' : String(value).trim().slice(0, f.field_type === 'textarea' ? 1000 : 300);
    if (value && f.field_type === 'number' && !Number.isFinite(Number(value))) {
      throw badRequest(`« ${f.field_label} » doit être un nombre`, { code: 'CHECKOUT_FIELD_INVALID', hint: f.field_name });
    }
    if (value && f.field_type === 'select' && Array.isArray(f.options) && f.options.length && !f.options.includes(value)) {
      throw badRequest(`Choix invalide pour « ${f.field_label} »`, { code: 'CHECKOUT_FIELD_INVALID', hint: f.field_name });
    }
    if (!value) {
      if (f.required) throw badRequest(`« ${f.field_label} » est obligatoire`, { code: 'CHECKOUT_FIELD_REQUIRED', hint: f.field_name });
      continue;
    }
    out.push({ label: String(f.field_label).slice(0, 120), name: f.field_name, value });
  }
  return out;
}

/** Notes line block appended to the order so answers show everywhere the order notes show. */
export function answersAsNotes(answers) {
  return answers.map((a) => `${a.label} : ${a.value}`).join('\n');
}

/** Parse the shop's delivery pricing settings (minor units). */
export function parseDeliverySettings(rows, toMinor) {
  const map = Object.fromEntries((rows || []).map((r) => [r.key, String(r.value ?? '').trim()]));
  const mode = map.delivery_pricing === 'flat' ? 'flat' : 'product';
  const flat = Math.max(0, toMinor(map.delivery_flat_fee || '0'));
  const freeOver = Math.max(0, toMinor(map.delivery_free_over || '0'));
  return { mode, flat, freeOver };
}

/**
 * Apply shop delivery pricing to priced rows (mutates row.deliveryMinor).
 * - product: each product's own delivery fee (default)
 * - flat: one fee per order, whatever the products
 * - freeOver > 0: delivery is free once merchandise (after offers) reaches the threshold
 * @returns total delivery in minor units
 */
export function applyShopDelivery(rows, settings, merchandiseMinor) {
  if (!rows.length) return 0;
  if (settings.mode === 'flat') rows.forEach((r, i) => { r.deliveryMinor = i === 0 ? settings.flat : 0; });
  if (settings.freeOver > 0 && merchandiseMinor >= settings.freeOver) rows.forEach((r) => { r.deliveryMinor = 0; });
  return rows.reduce((s, r) => s + r.deliveryMinor, 0);
}
