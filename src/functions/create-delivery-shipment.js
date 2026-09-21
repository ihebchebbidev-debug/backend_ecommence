// Port of supabase/functions/create-delivery-shipment/index.ts
import { json, methodGuard } from './_shared/respond.js';
import { decryptDeliveryCredentials, canEncryptDelivery, createShipment, assertAccountAndStore } from './_shared/delivery.js';

export default async function createDeliveryShipment(req, res, ctx) {
  if (methodGuard(req, res)) return;
  if (!ctx.userId) return json(res, { error: 'Non authentifié' }, 401);

  const { store_id, order_id, provider_id, provider_code, form_overrides } = req.body || {};

  if (!(await assertAccountAndStore(ctx, res, store_id))) return;

  const order = await ctx.q('SELECT * FROM public.orders WHERE id=$1 AND store_id=$2', [order_id, store_id]).then((r) => r[0]);
  if (!order) return json(res, { error: 'Commande introuvable' }, 404);
  if (order.status !== 'confirmed') return json(res, { error: 'La commande doit être confirmée avant l\'expédition' }, 400);

  const sub = await ctx.q('SELECT customer_data_locked FROM public.store_subscriptions WHERE store_id=$1', [store_id]).then((r) => r[0]);
  if (sub?.customer_data_locked) {
    return json(res, { error: 'Débloquez les données clients avant l\'envoi à la livraison. (Données clients masquées — rechargez votre solde ou activez votre abonnement.)', code: 'customer_data_locked' }, 403);
  }

  let provider;
  if (provider_id) provider = await ctx.q('SELECT * FROM public.delivery_providers WHERE id=$1', [provider_id]).then((r) => r[0]);
  else if (provider_code) provider = await ctx.q('SELECT * FROM public.delivery_providers WHERE code=$1', [provider_code]).then((r) => r[0]);
  else return json(res, { error: 'Provider requis' }, 400);

  if (!provider) return json(res, { error: 'Provider introuvable' }, 404);
  if (!provider.is_active) return json(res, { error: 'Provider désactivé' }, 403);

  const integration = await ctx.q(
    'SELECT * FROM public.store_delivery_integrations WHERE store_id=$1 AND provider_id=$2',
    [store_id, provider.id],
  ).then((r) => r[0]);
  if (!integration) return json(res, { error: 'Intégration non configurée' }, 400);
  if (!integration.enabled || integration.status !== 'connected') return json(res, { error: 'Intégration non connectée' }, 400);

  const existing = await ctx.q(
    'SELECT * FROM public.delivery_shipments WHERE order_id=$1 AND provider_id=$2',
    [order_id, provider.id],
  ).then((r) => r[0]);
  if (existing) {
    return json(res, { success: true, shipment: { id: existing.id, external_shipment_id: existing.external_shipment_id, tracking_number: existing.tracking_number, tracking_url: existing.tracking_url, label_url: existing.label_url, status: existing.status, already_exists: true } });
  }

  const secret = await ctx.q(
    'SELECT credentials_ciphertext, credentials_iv, encryption_version FROM public.delivery_integration_secrets WHERE integration_id=$1',
    [integration.id],
  ).then((r) => r[0]);
  if (!secret) return json(res, { error: 'Provider credentials not configured' }, 400);
  if (!canEncryptDelivery()) return json(res, { error: 'Delivery encryption key missing' }, 500);
  if (secret.encryption_version === 'legacy-xor-v0') return json(res, { error: 'Provider credentials not configured' }, 400);

  let credentials;
  try { credentials = decryptDeliveryCredentials(secret.credentials_ciphertext, secret.credentials_iv); }
  catch { return json(res, { error: 'Provider credentials not configured' }, 400); }

  if (provider.code === 'first_delivery') {
    if (form_overrides) {
      if (form_overrides.locality_id != null) order.locality_id = form_overrides.locality_id;
      if (form_overrides.client_name) order.client_name = form_overrides.client_name;
      if (form_overrides.client_phone) order.client_phone = form_overrides.client_phone;
      if (form_overrides.client_phone2 != null) order.client_phone2 = form_overrides.client_phone2;
      if (form_overrides.address) order.address = form_overrides.address;
      if (form_overrides.governorate) order.region = form_overrides.governorate;
      if (form_overrides.delegation) order.city = form_overrides.delegation;
      if (form_overrides.designation) order.product_name = form_overrides.designation;
      if (form_overrides.nombre_article != null) order.quantity = form_overrides.nombre_article;
      if (form_overrides.prix != null) order.amount = form_overrides.prix;
      if (form_overrides.prix_livraison != null) order.prix_livraison = form_overrides.prix_livraison;
      if (form_overrides.commentaire != null) order.notes = form_overrides.commentaire;
    }
    if (!order.locality_id) return json(res, { error: 'Localité First Delivery manquante. Veuillez choisir une localité valide.' }, 400);
  }

  const orderData = {
    order_number: order.order_number, client_name: order.client_name, client_phone: order.client_phone || '',
    client_phone2: order.client_phone2 || '', address: order.address || order.region || '',
    region: order.region || '', city: order.city || '', locality_id: order.locality_id || null,
    amount: order.amount, product_name: order.product_name, quantity: order.quantity, notes: order.notes,
    prix_livraison: order.prix_livraison ?? form_overrides?.prix_livraison ?? 0,
    nombre_echange: form_overrides?.nombre_echange ?? 0,
    ouvrir_colis: form_overrides?.ouvrir_colis ?? false,
    colis_fragile: form_overrides?.colis_fragile ?? false,
  };

  let shipmentResult;
  if (provider.integration_mode === 'manual') {
    shipmentResult = { success: true, external_shipment_id: `manual-${Date.now()}`, tracking_number: null, tracking_url: null, label_url: null, status: 'created', raw_response: { mode: 'manual' } };
  } else {
    const enrichedIntegration = provider.code === 'first_delivery'
      ? { ...integration, provider_settings: { ...(integration.provider_settings || {}), default_nombre_echange: orderData.nombre_echange ?? 0, ouvrir_colis: orderData.ouvrir_colis, colis_fragile: orderData.colis_fragile } }
      : integration;
    shipmentResult = await createShipment(provider, credentials, enrichedIntegration, orderData);
  }

  if (!shipmentResult.success) {
    return json(res, { error: `Échec création expédition: ${shipmentResult.error}`, fd_error: shipmentResult.error }, 502);
  }

  const shipment = await ctx.one(
    `INSERT INTO public.delivery_shipments
       (store_id, order_id, provider_id, provider_code, integration_id, external_shipment_id, tracking_number, tracking_url, label_url, status, shipment_payload, provider_response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [store_id, order_id, provider.id, provider.code, integration.id, shipmentResult.external_shipment_id, shipmentResult.tracking_number,
      shipmentResult.tracking_url, shipmentResult.label_url, shipmentResult.status, JSON.stringify(orderData), JSON.stringify(shipmentResult.raw_response)],
  );

  await ctx.q(
    `INSERT INTO public.delivery_tracking_events (shipment_id, store_id, event_type, status, description, raw_data)
     VALUES ($1,$2,'shipment_created',$3,$4,$5)`,
    [shipment.id, store_id, shipmentResult.status, `Expédition créée via ${provider.name}`, JSON.stringify(shipmentResult.raw_response)],
  );

  await ctx.q(
    `UPDATE public.orders SET delivery_status=$1, tracking_number=$2, updated_at=now() WHERE id=$3`,
    [shipmentResult.status, shipmentResult.tracking_number, order_id],
  );

  return json(res, {
    success: true,
    shipment: {
      id: shipment.id, external_shipment_id: shipmentResult.external_shipment_id, tracking_number: shipmentResult.tracking_number,
      tracking_url: shipmentResult.tracking_url, label_url: shipmentResult.label_url, status: shipmentResult.status,
      provider_name: provider.name, already_exists: false, warning: shipmentResult.warning || null,
    },
  });
}
