// AES-256-GCM credential encryption — the Node.js port of
// supabase/functions/_shared/crypto.ts and _shared/paymentCrypto.ts.
// Ciphertext produced by the Deno version stays readable: same algorithm,
// same base64 encoding, same 12-byte IV, key = SHA-256 of the env secret.
import crypto from 'node:crypto';

const VERSION = 'v1';

function keyFor(envName) {
  const secret = process.env[envName];
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export const deliveryKey = () => keyFor('DELIVERY_CREDENTIALS_ENCRYPTION_KEY');
export const paymentKey = () => keyFor('PAYMENT_CREDENTIALS_ENCRYPTION_KEY');

export const canEncrypt = (key) => !!key;

/** @returns {{ ciphertext: string, iv: string, version: string }} */
export function encryptJson(key, value) {
  if (!key) throw new Error('Encryption key missing');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: enc.toString('base64'), iv: iv.toString('base64'), version: VERSION };
}

export function decryptJson(key, ciphertextB64, ivB64) {
  if (!key) throw new Error('Encryption key missing');
  const raw = Buffer.from(ciphertextB64, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(out);
}

/** Show only the last 4 characters of every credential field. */
export function maskCredentials(creds) {
  const masked = {};
  for (const [k, v] of Object.entries(creds || {})) {
    const s = String(v ?? '');
    masked[k] = s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
  }
  return masked;
}

export const md5 = (input) => crypto.createHash('md5').update(input, 'utf8').digest('hex');
export const sha256Hex = (input) => crypto.createHash('sha256').update(input, 'utf8').digest('hex');

export function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
