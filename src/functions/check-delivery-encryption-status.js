import { json } from './_shared/respond.js';
import { canEncryptDelivery } from './_shared/delivery.js';

export default async function checkDeliveryEncryptionStatus(req, res) {
  return json(res, { configured: canEncryptDelivery() });
}
