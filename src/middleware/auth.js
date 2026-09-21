// Resolves the caller exactly like Supabase does:
//   apikey header / Authorization bearer → role anon | authenticated | service_role
import { verifyToken } from '../lib/jwt.js';
import { makeContext } from '../lib/context.js';
import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

export function authContext(req, _res, next) {
  const apikey = req.headers.apikey || req.headers['x-api-key'] || '';
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';

  let role = 'anon';
  let userId = null;
  let claims = null;

  const token = bearer || apikey;
  if (token) {
    try {
      claims = verifyToken(token);
      if (claims.role === 'service_role') role = 'service_role';
      else if (claims.sub) {
        role = 'authenticated';
        userId = claims.sub;
      } else role = claims.role || 'anon';
    } catch {
      // An invalid *bearer* token is an error; an unusable apikey just means anon.
      if (bearer) {
        req.authError = unauthorized('invalid JWT: unable to parse or verify signature');
      }
    }
  }

  // Service role can impersonate a user for RPCs that need auth.uid().
  if (role === 'service_role' && req.headers['x-user-id']) userId = String(req.headers['x-user-id']);

  req.apikeyPresent = Boolean(apikey || config.anonKey === '');
  req.ctx = makeContext({ userId, role, claims });
  req.accessToken = bearer || null;
  next();
}

/** Use on routes that were deployed with verify_jwt = true. */
export function requireJwt(req, _res, next) {
  if (req.authError) return next(req.authError);
  if (req.ctx.role === 'anon') return next(unauthorized('Missing authorization header'));
  next();
}
