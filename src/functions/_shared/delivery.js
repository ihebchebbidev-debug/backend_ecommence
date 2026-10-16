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

/** Providers can reject a request with HTTP 200; never treat that as success. */
export function deliveryResponseError(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const firstShipment = Array.isArray(data.Shipments) ? data.Shipments[0] : null;
  const notes = [].concat(data.Notifications || [], firstShipment?.Notifications || []);
  if (data.HasErrors === true || firstShipment?.HasErrors === true) {
    return String(notes.map((n) => n?.Message).filter(Boolean).join(' · ') || 'Le transporteur a refusé la demande');
  }
  if (String(data.result_type || '').toLowerCase() === 'erreur') {
    return String(data.result_content?.message || data.result_code || 'Le transporteur a refusé la demande');
  }
  if (/erreur|error/i.test(String(data.status_message || ''))) return String(data.status_message);
  if (data.isError === true || data.isError === 'true' || data.success === false || data.success === 'false' || data.status === false || data.error) {
    return String(data.message || data.error || 'Le transporteur a refusé la demande');
  }
  return null;
}

const xmlEscape = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (v) => String(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Endpoints may be absolute and may carry `{{credentials.x}}` (e.g. Navex puts its token in the path). */
export function providerUrl(provider, endpoint, credentials) {
  const ep = endpoint || '';
  const raw = /^https?:\/\//i.test(ep) ? ep : `${provider.base_url || ''}${ep}`;
  return raw.replace(/\{\{\s*credentials\.(\w+)\s*\}\}/g, (_, k) => encodeURIComponent(cleanToken(credentials?.[k])));
}

/** Builds the HTTP body for the provider's wire format: JSON (default), form-encoded, or Colissimo Tunisie SOAP. */
export function buildProviderRequest(provider, credentials, payload) {
  const headers = buildAuthHeaders(provider, credentials);
  const { __format: format = 'json', __operation: operation, __method: method = 'POST', ...fields } = payload || {};
  if (format === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, v == null ? '' : String(v)])).toString();
    return { method, headers, body, format, operation };
  }
  if (format === 'colissimo_soap') {
    headers['Content-Type'] = 'text/xml; charset=utf-8';
    headers.Accept = 'text/xml';
    headers.SOAPAction = `"http://tempuri.org/${operation}"`;
    const params = Object.entries(fields).map(([k, v]) => `<${k}>${xmlEscape(typeof v === 'object' ? JSON.stringify(v) : v)}</${k}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><AuthHeader xmlns="http://tempuri.org/"><Uilisateur>${xmlEscape(cleanToken(credentials.username))}</Uilisateur><Pass>${xmlEscape(cleanToken(credentials.password))}</Pass></AuthHeader></soap:Header><soap:Body><${operation} xmlns="http://tempuri.org/">${params}</${operation}></soap:Body></soap:Envelope>`;
    return { method, headers, body, format, operation };
  }
  return { method, headers, body: JSON.stringify(fields), format, operation };
}

/** Parses JSON replies, and unwraps a SOAP `<OperationResult>` that itself contains JSON. */
export function parseProviderResponse(text, format, operation) {
  if (format === 'colissimo_soap') {
    const m = new RegExp(`<${operation}Result>([\\s\\S]*?)</${operation}Result>`).exec(text || '');
    if (!m) return {};
    const inner = xmlUnescape(m[1]);
    try { return JSON.parse(inner); } catch { return { result_content: inner }; }
  }
  try { return JSON.parse(text); } catch { return {}; }
}

export async function sendProviderRequest(provider, credentials, endpoint, payload, timeoutMs = 30000) {
  const req = buildProviderRequest(provider, credentials, payload);
  const res = await fetch(providerUrl(provider, endpoint, credentials), { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => '');
  return { res, data: parseProviderResponse(text, req.format, req.operation) };
}

const scalar = (v) => (v != null && v !== '' && typeof v !== 'object' ? v : null);

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
  let payload = deepReplace(provider.create_shipment_payload_template || {}, {
    order: { ...order, amount: String(order.amount), quantity: String(order.quantity), date_ms: `/Date(${Date.now()})/` },
    sender: integration.sender_config || {},
    settings: integration.provider_settings || {},
    credentials: credentials || {},
  });

  if (provider.code === 'first_delivery') payload = coerceFirstDeliveryPayload(payload);
  if (payload?.pic && typeof payload.pic === 'object') {
    for (const f of ['prix', 'nb_pieces', 'echange']) if (payload.pic[f] != null && payload.pic[f] !== '') payload.pic[f] = Number(payload.pic[f]);
  }
  const fail = (data, error) => ({ success: false, external_shipment_id: null, tracking_number: null, tracking_url: null, label_url: null, status: 'failed', raw_response: data, error, warning: null });

  try {
    const { res, data } = await sendProviderRequest(provider, credentials, provider.create_shipment_endpoint, payload);
    if (!res.ok) return fail(data, deliveryResponseError(data) || `HTTP ${res.status}`);
    const refused = deliveryResponseError(data);
    if (refused) return fail(data, refused);
    const m = provider.response_mapping || {};
    const trackingPaths = [m.tracking_number, 'result.barCode', 'result.barcode', 'result.codeBarre', 'data.barCode', 'data.barcode', 'barCode', 'barcode', 'Shipments.0.ID', 'result_content.code_barre', 'result_content.barcode', 'result_content', 'code_barre', 'colis.code_barre', 'colis.code'].filter(Boolean);
    const idPaths = [m.external_shipment_id, 'result.id', 'data.id', 'id', 'result.barCode', 'barCode', 'Shipments.0.ID'].filter(Boolean);
    const pick = (paths) => { for (const p of paths) { const v = scalar(extractValueByPath(data, p)); if (v != null) return String(v); } return null; };
    const trackingNumber = pick(trackingPaths);
    const externalId = pick(idPaths) || trackingNumber;
    const warning = trackingNumber ? null : "Commande envoyée, mais aucun code à barre n'a été retourné.";
    return {
      success: true,
      external_shipment_id: externalId,
      tracking_number: trackingNumber,
      tracking_url: pick([m.tracking_url, 'data.tracking_url'].filter(Boolean)),
      label_url: pick([m.label_url, 'data.label_url', 'result.link', 'Shipments.0.ShipmentLabel.LabelURL'].filter(Boolean)),
      status: 'created',
      raw_response: data,
      warning,
    };
  } catch (err) {
    return fail({}, `Fetch: ${err.message}`);
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
