import crypto from 'node:crypto';
import { decryptJson, encryptJson, paymentKey } from './crypto.js';

export function paymentEncryptionKey() {
  const raw = process.env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw.trim().replace(/^["']|["']$/g, ''), 'base64');
    if (key.length !== 32) throw new Error('Payment encryption key must decode to exactly 32 bytes');
    return key;
  }
  const environment = (process.env.APP_ENV || process.env.ENVIRONMENT || process.env.NODE_ENV || '').toLowerCase();
  if (environment === 'production' || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Payment encryption key missing');
  return crypto.createHash('sha256').update(`${process.env.SUPABASE_SERVICE_ROLE_KEY}::payment-credentials`, 'utf8').digest();
}

export function canEncryptPaymentCredentials() {
  try { paymentEncryptionKey(); return true; } catch { return false; }
}

export function encryptPaymentJson(data) {
  return { ...encryptJson(paymentEncryptionKey(), data), version: 'aes-gcm-v1' };
}

export function decryptPaymentJson(ciphertext, iv, version) {
  if (version === 'v1') return decryptJson(paymentKey(), ciphertext, iv);
  if (version && version !== 'aes-gcm-v1') throw new Error('Unsupported payment encryption version');
  try { return decryptJson(paymentEncryptionKey(), ciphertext, iv); }
  catch (error) {
    // Older rows without a version used the hashed-secret key.
    if (version) throw error;
    return decryptJson(paymentKey(), ciphertext, iv);
  }
}