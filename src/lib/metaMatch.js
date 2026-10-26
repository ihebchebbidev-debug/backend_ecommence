// Normalizes and hashes shopper contact details the way Meta's Conversions API expects
// (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters).
import crypto from 'node:crypto';

export const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

const DIAL = { tn: '216', dz: '213', ma: '212', ly: '218', eg: '20', fr: '33', be: '32', ch: '41', de: '49', it: '39', es: '34', ca: '1', us: '1', gb: '44', sa: '966', ae: '971', qa: '974' };
const NATIONAL_LEN = { tn: 8, dz: 9, ma: 9, fr: 9, ly: 9 };

/** Digits only, with country code, no leading zeros or "+": 22123456 (TN) → 21622123456. */
export function normalizePhone(raw, country = 'tn') {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  const c = String(country || 'tn').toLowerCase();
  const dial = DIAL[c];
  if (dial && !d.startsWith(dial)) {
    const nat = d.replace(/^0+/, '');
    if (!NATIONAL_LEN[c] || nat.length === NATIONAL_LEN[c]) d = dial + nat;
  }
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export const normalizeEmail = (e) => {
  const v = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

// Lowercase, no accents/punctuation/spaces (Meta's rule for fn, ln, ct, st). Arabic letters are kept.
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { fn: null, ln: null };
  return { fn: plain(parts[0]) || null, ln: parts.length > 1 ? plain(parts.slice(1).join('')) || null : null };
}

/**
 * Hashed customer details for one order. Only call when the shopper accepted.
 * `order` holds client_name, client_phone, client_phone2, city, region, client_id.
 */
export function hashedUserData(order, { email, country } = {}) {
  const c = /^[a-z]{2}$/i.test(String(country || '')) ? String(country).toLowerCase() : 'tn';
  const out = {};
  const phones = [order.client_phone, order.client_phone2].map((p) => normalizePhone(p, c)).filter(Boolean);
  if (phones.length) out.ph = [...new Set(phones)].map(sha256);
  const em = normalizeEmail(email);
  if (em) out.em = [sha256(em)];
  const { fn, ln } = splitName(order.client_name);
  if (fn) out.fn = [sha256(fn)];
  if (ln) out.ln = [sha256(ln)];
  const ct = plain(order.city);
  if (ct) out.ct = [sha256(ct)];
  const st = plain(order.region);
  if (st) out.st = [sha256(st)];
  out.country = [sha256(c)];
  // Stable per shopper: the shop's client record, else the phone, so repeat buyers link up.
  const ext = order.client_id || phones[0];
  if (ext) out.external_id = [sha256(String(ext))];
  return out;
}
