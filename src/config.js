import 'dotenv/config';
import crypto from 'node:crypto';

const INSECURE_JWT_SECRET = 'dev-insecure-secret-change-me';
const PLACEHOLDER_DB_URL = 'postgresql://postgres:postgres@localhost:5432/appdb';

function list(value, fallback) {
  const parsed = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

// In development a missing JWT_SECRET is replaced by a per-boot random secret
// instead of a well-known string, so leaked dev tokens are worthless.
const jwtSecret =
  process.env.JWT_SECRET && process.env.JWT_SECRET !== INSECURE_JWT_SECRET
    ? process.env.JWT_SECRET
    : isProduction
      ? ''
      : crypto.randomBytes(48).toString('base64url');

export const config = {
  port: Number(process.env.PORT || 8000),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8000}`,
  databaseUrl: process.env.DATABASE_URL || PLACEHOLDER_DB_URL,
  jwtSecret,
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL || 3600),
  refreshTokenTtl: Number(process.env.REFRESH_TOKEN_TTL || 60 * 60 * 24 * 30),
  anonKey: process.env.ANON_KEY || '',
  serviceRoleKey: process.env.SERVICE_ROLE_KEY || '',
  storageDir: process.env.STORAGE_DIR || './storage-data',
  env: process.env.NODE_ENV || 'development',
  isProduction,
  // Run db/*.sql + drift reconciliation on every boot (AUTO_MIGRATE=false to skip).
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
  // Create missing tables/columns when a request needs them (AUTO_SCHEMA=false to skip).
  autoSchema: process.env.AUTO_SCHEMA !== 'false',
  // Buckets created on boot. Any other bucket is created by its first upload.
  storageBuckets: list(process.env.STORAGE_BUCKETS, ['platform-assets', 'theme-previews', 'uploads']),
  // Buckets only platform admins may write to (everyone can read).
  adminOnlyBuckets: list(process.env.STORAGE_ADMIN_BUCKETS, ['platform-assets', 'theme-previews']),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024),
  // Tables that publish live changes over the realtime websocket.
  realtimeTables: list(process.env.REALTIME_TABLES, ['orders']),
  // Outgoing email (password reset, sign-up confirmation).
  email: {
    from: process.env.EMAIL_FROM || 'no-reply@localhost',
    resendApiKey: process.env.RESEND_API_KEY || '',
    webhookUrl: process.env.EMAIL_WEBHOOK_URL || '',
    webhookSecret: process.env.EMAIL_WEBHOOK_SECRET || '',
  },
  // Return the OTP code in the response when no SMS provider is configured.
  // Never honoured in production, whatever the env var says.
  devOtpAllowed: process.env.DEV_OTP_ALLOWED === 'true' && !isProduction,
};

export const emailConfigured = () => !!(config.email.resendApiKey || config.email.webhookUrl);

/**
 * Fail fast on unsafe production configuration; warn in development.
 * @returns {{ fatal: string[], warnings: string[] }}
 */
export function checkConfig() {
  const fatal = [];
  const warnings = [];

  if (!config.jwtSecret) fatal.push('JWT_SECRET is not set (required in production)');
  else if (config.jwtSecret.length < 32) {
    (config.isProduction ? fatal : warnings).push('JWT_SECRET should be at least 32 characters');
  }
  if (config.isProduction && config.databaseUrl === PLACEHOLDER_DB_URL) {
    fatal.push('DATABASE_URL is still the local placeholder');
  }
  if (!process.env.JWT_SECRET && !config.isProduction) {
    warnings.push('JWT_SECRET missing — using a random secret for this boot only');
  }
  if (!emailConfigured()) {
    (config.isProduction ? fatal : warnings).push(
      'no email provider configured (RESEND_API_KEY or EMAIL_WEBHOOK_URL) — password reset emails cannot be sent',
    );
  }
  for (const key of ['DELIVERY_CREDENTIALS_ENCRYPTION_KEY', 'PAYMENT_CREDENTIALS_ENCRYPTION_KEY']) {
    if (!process.env[key]) warnings.push(`${key} not set — the matching integrations refuse to save credentials`);
  }
  if (config.devOtpAllowed) warnings.push('DEV_OTP_ALLOWED=true — OTP codes are returned to super admins');

  return { fatal, warnings };
}
