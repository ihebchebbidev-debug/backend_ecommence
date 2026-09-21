// /functions/v1/:name — the 19 edge functions, ported to Express.
//
// Each module default-exports `(req, res, ctx) => ...` and is mounted under the
// exact name the frontend calls with supabase.functions.invoke(name).
// `verifyJwt` mirrors docs/security-remediation/edge-functions/verify-jwt-map.md
// and deploy/backend/kong.yml: 4 functions are publicly callable (storefront
// checkout + gateway callbacks + the Meta webhook), 15 require a signed-in caller.
import express from 'express';
import { asyncHandler, notFound } from '../lib/errors.js';
import { requireJwt } from '../middleware/auth.js';

import phoneOtp from './phone-otp.js';
import resetOtpRateLimit from './reset-otp-rate-limit.js';
import createDeliveryShipment from './create-delivery-shipment.js';
import cancelDeliveryShipment from './cancel-delivery-shipment.js';
import trackDeliveryShipment from './track-delivery-shipment.js';
import syncDeliveryLocalities from './sync-delivery-localities.js';
import saveDeliveryIntegration from './save-delivery-integration.js';
import checkDeliveryEncryptionStatus from './check-delivery-encryption-status.js';
import createPayment from './create-payment.js';
import paymentCallback from './payment-callback.js';
import createStorePayment from './create-store-payment.js';
import storePaymentCallback from './store-payment-callback.js';
import savePaymentIntegration from './save-payment-integration.js';
import testPaymentGateway from './test-payment-gateway.js';
import testStorePayment from './test-store-payment.js';
import metaCapi from './meta-capi.js';
import adminDeleteAuthUser from './admin-delete-auth-user.js';
import whatsappRegister from './whatsapp-register.js';
import whatsappWebhook from './whatsapp-webhook.js';

/** name → { handler, verifyJwt } — verifyJwt matches supabase/config.toml. */
export const edgeFunctions = {
  'phone-otp': { handler: phoneOtp, verifyJwt: true },
  'reset-otp-rate-limit': { handler: resetOtpRateLimit, verifyJwt: true },
  'create-delivery-shipment': { handler: createDeliveryShipment, verifyJwt: true },
  'cancel-delivery-shipment': { handler: cancelDeliveryShipment, verifyJwt: true },
  'track-delivery-shipment': { handler: trackDeliveryShipment, verifyJwt: true },
  'sync-delivery-localities': { handler: syncDeliveryLocalities, verifyJwt: true },
  'save-delivery-integration': { handler: saveDeliveryIntegration, verifyJwt: true },
  'check-delivery-encryption-status': { handler: checkDeliveryEncryptionStatus, verifyJwt: true },
  'create-payment': { handler: createPayment, verifyJwt: true },
  'payment-callback': { handler: paymentCallback, verifyJwt: false },
  'create-store-payment': { handler: createStorePayment, verifyJwt: false },
  'store-payment-callback': { handler: storePaymentCallback, verifyJwt: false },
  'save-payment-integration': { handler: savePaymentIntegration, verifyJwt: true },
  'test-payment-gateway': { handler: testPaymentGateway, verifyJwt: true },
  'test-store-payment': { handler: testStorePayment, verifyJwt: true },
  'meta-capi': { handler: metaCapi, verifyJwt: true },
  'admin-delete-auth-user': { handler: adminDeleteAuthUser, verifyJwt: true },
  'whatsapp-register': { handler: whatsappRegister, verifyJwt: true },
  'whatsapp-webhook': { handler: whatsappWebhook, verifyJwt: false },
};

export const functionsRouter = express.Router();

functionsRouter.all(
  '/:name',
  asyncHandler(async (req, res, next) => {
    const entry = edgeFunctions[req.params.name];
    if (!entry) throw notFound(`Function not found`, { code: 'NOT_FOUND' });
    if (entry.verifyJwt) {
      let failed = null;
      requireJwt(req, res, (err) => { failed = err; });
      if (failed) return next(failed);
    }
    return entry.handler(req, res, req.ctx);
  }),
);
