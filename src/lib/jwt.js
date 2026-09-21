import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/** Access token with the same claim shape Supabase/GoTrue issues. */
export function signAccessToken(user, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      phone: user.phone || '',
      session_id: sessionId,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: user.raw_user_meta_data || {},
      iat: now,
      exp: now + config.accessTokenTtl,
    },
    config.jwtSecret,
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

/** Mint the anon / service_role API keys (see scripts/make-keys.js). */
export function signApiKey(role) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ role, iss: 'nodejs_backend', iat: now, exp: now + 60 * 60 * 24 * 365 * 5 }, config.jwtSecret);
}
