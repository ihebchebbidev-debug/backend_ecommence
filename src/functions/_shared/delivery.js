// Shared helpers for the delivery-provider edge functions.
import { deliveryKey, decryptJson as sharedDecryptJson } from './crypto.js';

/** Decrypt delivery credentials using the shared AES-GCM helper. */
export function decryptDeliveryCredentials(ciphertext, iv) {
  const key = deliveryKey();
  if (!key) throw new Error('Delivery encryption key missing');
  return sharedDecryptJson(key, ciphertext, iv);
}

export const canEncryptDelivery = () => !!deliveryKey();

export function cleanToken(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '');
}

export function buildAuthHeaders(provider, credentials) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  switch (provider.auth_type) {
    case 'api_key': {
      const h = provider.auth_header_name || 'X-API-Key';
      const v = cleanToken(credentials.api_key || credentials.key || '');
      if (v) headers[h] = v;
      break;
    }
    case 'bearer_token': {
      const h = provider.auth_header_name || 'Authorization';
      const v = cleanToken(credentials.api_token || credentials.token || credentials.api_key || '');
      if (v) headers[h] = `Bearer ${v}`;
      break;
    }
    case 'basic_auth': {
      const u = cleanToken(credentials.username || credentials.api_key || '');
      const p = cleanToken(credentials.password || credentials.api_secret || '');
      if (u && p) headers['Authorization'] = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
      break;
    }
    case 'custom_header': {
      const h = provider.auth_header_name || 'X-Custom-Auth';
      const v = cleanToken(credentials.api_key || credentials.token || '');
      if (v) headers[h] = v;
      break;
    }
  }
  return headers;
}

function replacePlaceholders(str, ctx) {
  const full = str.match(/^\{\{\s*(\w+)\.(\w+)\s*\}\}$/);
  if (full) {
    const val = ctx[full[1]]?.[full[2]];
    if (val !== undefined && val !== null) return val;
    if (val === null) return '';
  }
  return str.replace(/\{\{\s*(\w+)\.(\w+)\s*\}\}/g, (_, ns, k) => {
    const v = ctx[ns]?.[k];
    return v !== undefined && v !== null ? String(v) : '';
  });
}

export function deepReplace(obj, ctx) {
  if (typeof obj === 'string') return replacePlaceholders(obj, ctx);
  if (Array.isArray(obj)) return obj.map((i) => deepReplace(i, ctx));
  if (obj && typeof obj === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(obj)) r[k] = deepReplace(v, ctx);
    return r;
  }
  return obj;
}

export function extractValueByPath(res, path) {
  if (!path) return null;
  let cur = res;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur ?? null;
}

export function extractFirstMatch(res, paths) {
  for (const p of paths) {
    const v = extractValueByPath(res, p);
    if (v != null && v !== '') return v;
  }
  return null;
}

export function mapStatus(mapping, status) {
  const s = String(status ?? '');
  const n = s.toLowerCase().trim();
  return mapping[n] || mapping[s] || n;
}

/** First Delivery payload template wraps numeric fields in quotes — coerce back to Number. */
export function coerceFirstDeliveryPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const numericClientFields = ['locality_id'];
  const numericProduitFields = ['prix', 'nombreArticle', 'nombreEchange'];
  if (payload.Client && typeof payload.Client === 'object') {
    for (const f of numericClientFields) if (payload.Client[f] != null) payload.Client[f] = Number(payload.Client[f]);
  }
  if (payload.Produit && typeof payload.Produit === 'object') {
    for (const f of numericProduitFields) if (payload.Produit[f] != null) payload.Produit[f] = Number(payload.Produit[f]);
  }
  return payload;
}

export async function createShipment(provider, credentials, integration, order) {
  const url = `${provider.base_url || ''}${provider.create_shipment_endpoint || ''}`;
  const headers = buildAuthHeaders(provider, credentials);
  let payload = deepReplace(provider.create_shipment_payload_template || {}, {
    order: { ...order, amount: String(order.amount), quantity: String(order.quantity) },
    sender: integration.sender_config || {},
    settings: integration.provider_settings || {},
  });

  if (provider.code === 'first_delivery') payload = coerceFirstDeliveryPayload(payload);

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const fdError = data?.isError ? String(data.message || data.error || '') : '';
      const errorDetail = fdError || `HTTP ${res.status}`;
      return { success: false, external_shipment_id: null, tracking_number: null, tracking_url: null, label_url: null, status: 'failed', raw_response: data, error: errorDetail, warning: null };
    }
    if (data?.isError === true || data?.isError === 'true') {
      const fdError = String(data.message || data.error || 'First Delivery returned isError');
      return { success: false, external_shipment_id: null, tracking_number: null, tracking_url: null, label_url: null, status: 'failed', raw_response: data, error: fdError, warning: null };
    }
    const m = provider.response_mapping || {};
    const trackingPaths = [m.tracking_number, 'result.barCode', 'result.barcode', 'result.codeBarre', 'data.barCode', 'data.barcode', 'barCode', 'barcode'].filter(Boolean);
    const idPaths = [m.external_shipment_id, 'result.id', 'data.id', 'id', 'result.barCode', 'barCode'].filter(Boolean);
    const trackingNumber = extractFirstMatch(data, trackingPaths) || null;
    const externalId = extractFirstMatch(data, idPaths) || null;
    const warning = trackingNumber ? null : "Commande envoyée, mais aucun code à barre n'a été retourné.";
    return {
      success: true,
      external_shipment_id: externalId,
      tracking_number: trackingNumber,
      tracking_url: extractValueByPath(data, m.tracking_url || 'data.tracking_url') || null,
      label_url: extractValueByPath(data, m.label_url || 'data.label_url') || null,
      status: 'created',
      raw_response: data,
      warning,
    };
  } catch (err) {
    return { success: false, external_shipment_id: null, tracking_number: null, tracking_url: null, label_url: null, status: 'failed', raw_response: {}, error: `Fetch: ${err.message}`, warning: null };
  }
}

export async function checkSuperAdmin(ctx, userId) {
  const row = await ctx.q('SELECT role FROM public.admin_roles WHERE user_id = $1', [userId]).then((r) => r[0]);
  return row?.role === 'super_admin' || row?.role === 'limited_super_admin';
}

export async function assertAccountAndStore(ctx, res, storeId, allowedRoles = ['owner', 'admin', 'manager']) {
  const profile = await ctx.q('SELECT status, deleted_at, suspended_at FROM public.profiles WHERE id=$1', [ctx.userId]).then((r) => r[0]);
  if (profile?.deleted_at || profile?.status === 'deleted') { res.status(403).json({ error: 'Compte supprimé' }); return false; }
  if (profile?.suspended_at || profile?.status === 'suspended') { res.status(403).json({ error: 'Compte suspendu' }); return false; }

  const isSuperAdmin = await checkSuperAdmin(ctx, ctx.userId);
  if (!isSuperAdmin) {
    const member = await ctx.q(
      `SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND role = ANY($3)`,
      [storeId, ctx.userId, allowedRoles],
    ).then((r) => r[0]);
    if (!member) { res.status(403).json({ error: 'Accès refusé au magasin' }); return false; }
  }
  return true;
}
