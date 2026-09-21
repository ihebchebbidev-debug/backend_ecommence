// /auth/v1/* — GoTrue-compatible endpoints backed by auth.users.
// Covers every method the frontend uses: signUp, signInWithPassword, signOut,
// resetPasswordForEmail, updateUser, resend, getUser, and token refresh.
import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { signAccessToken } from '../lib/jwt.js';
import { asyncHandler, ApiError, badRequest, unauthorized } from '../lib/errors.js';
import { sendMail, recoveryEmail, confirmationEmail } from '../lib/mailer.js';

export const authRouter = express.Router();

const publicUser = (u) => ({
  id: u.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: u.email,
  phone: u.phone || '',
  email_confirmed_at: u.email_confirmed_at,
  phone_confirmed_at: u.phone_confirmed_at,
  confirmed_at: u.email_confirmed_at || u.phone_confirmed_at,
  last_sign_in_at: u.last_sign_in_at,
  app_metadata: u.raw_app_meta_data || {},
  user_metadata: u.raw_user_meta_data || {},
  identities: [],
  created_at: u.created_at,
  updated_at: u.updated_at,
});

async function newSession(user, req) {
  const session = await one(
    `INSERT INTO auth.sessions (user_id, user_agent, ip, not_after)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval) RETURNING *`,
    [user.id, req.headers['user-agent'] || null, req.ip, String(config.refreshTokenTtl)],
  );
  const refreshToken = crypto.randomBytes(24).toString('base64url');
  await q(
    `INSERT INTO auth.refresh_tokens (token, session_id, user_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [refreshToken, session.id, user.id, String(config.refreshTokenTtl)],
  );
  await q('UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1', [user.id]);

  return {
    access_token: signAccessToken(user, session.id),
    token_type: 'bearer',
    expires_in: config.accessTokenTtl,
    expires_at: Math.floor(Date.now() / 1000) + config.accessTokenTtl,
    refresh_token: refreshToken,
    user: publicUser(user),
  };
}

async function currentUser(req) {
  if (!req.ctx.userId) throw unauthorized('invalid claim: missing sub claim');
  const u = await one('SELECT * FROM auth.users WHERE id = $1 AND deleted_at IS NULL', [req.ctx.userId]);
  if (!u) throw unauthorized('User from sub claim in JWT does not exist');
  return u;
}

// ── POST /auth/v1/signup ─────────────────────────────────────────────
authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const { email, password, data = {}, phone } = req.body || {};
    if (!email && !phone) throw badRequest('Email or phone is required', { code: 'validation_failed' });
    if (!password || String(password).length < 6)
      throw new ApiError(422, 'Password should be at least 6 characters', { code: 'weak_password' });

    const existing = await one('SELECT id FROM auth.users WHERE email = $1', [String(email).toLowerCase()]);
    if (existing) throw new ApiError(422, 'User already registered', { code: 'user_already_exists' });

    const hash = await bcrypt.hash(String(password), 10);
    const user = await one(
      `INSERT INTO auth.users (email, phone, encrypted_password, raw_user_meta_data, email_confirmed_at, confirmation_token, confirmation_sent_at)
       VALUES ($1, $2, $3, $4::jsonb, now(), $5, now()) RETURNING *`,
      [String(email).toLowerCase(), phone || null, hash, JSON.stringify(data || {}), crypto.randomBytes(16).toString('hex')],
    );

    // Mirror the live `handle_new_user` trigger: create the profile row.
    await q(
      `INSERT INTO public.profiles (id, email, full_name, country, status)
       VALUES ($1, $2, $3, $4, 'active') ON CONFLICT (id) DO NOTHING`,
      [user.id, user.email, data.full_name || null, data.country || null],
    );

    // GoTrue with autoconfirm returns the token response FLAT (access_token,
    // refresh_token, user, …). supabase-js only recognises a session when
    // access_token/refresh_token sit at the top level (_sessionResponse →
    // hasSession), so a nested { session } would leave the client signed out.
    return res.status(200).json(await newSession(user, req));
  }),
);

// ── POST /auth/v1/token?grant_type=password|refresh_token ────────────
authRouter.post(
  '/token',
  asyncHandler(async (req, res) => {
    const grant = req.query.grant_type || 'password';

    if (grant === 'password') {
      const { email, password } = req.body || {};
      const user = await one('SELECT * FROM auth.users WHERE email = $1 AND deleted_at IS NULL', [
        String(email || '').toLowerCase(),
      ]);
      const ok = user?.encrypted_password && (await bcrypt.compare(String(password || ''), user.encrypted_password));
      if (!ok) throw new ApiError(400, 'Invalid login credentials', { code: 'invalid_credentials' });
      if (user.banned_until && new Date(user.banned_until) > new Date())
        throw new ApiError(403, 'User is banned', { code: 'user_banned' });

      const profile = await one('SELECT status, deleted_at FROM public.profiles WHERE id = $1', [user.id]);
      if (profile?.deleted_at || profile?.status === 'deleted')
        throw new ApiError(403, 'Compte supprimé', { code: 'user_deleted' });

      return res.json(await newSession(user, req));
    }

    if (grant === 'refresh_token') {
      const token = req.body?.refresh_token;
      const row = await one(
        'SELECT * FROM auth.refresh_tokens WHERE token = $1 AND revoked = false AND expires_at > now()',
        [token],
      );
      if (!row) throw new ApiError(400, 'Invalid Refresh Token: Refresh Token Not Found', { code: 'refresh_token_not_found' });
      await q('UPDATE auth.refresh_tokens SET revoked = true WHERE token = $1', [token]);
      const user = await one('SELECT * FROM auth.users WHERE id = $1 AND deleted_at IS NULL', [row.user_id]);
      if (!user) throw unauthorized('User not found');

      const newToken = crypto.randomBytes(24).toString('base64url');
      await q(
        `INSERT INTO auth.refresh_tokens (token, session_id, user_id, parent, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
        [newToken, row.session_id, user.id, token, String(config.refreshTokenTtl)],
      );
      return res.json({
        access_token: signAccessToken(user, row.session_id),
        token_type: 'bearer',
        expires_in: config.accessTokenTtl,
        expires_at: Math.floor(Date.now() / 1000) + config.accessTokenTtl,
        refresh_token: newToken,
        user: publicUser(user),
      });
    }

    throw badRequest(`unsupported grant_type "${grant}"`);
  }),
);

// ── GET /auth/v1/user  &  PUT /auth/v1/user ──────────────────────────
authRouter.get(
  '/user',
  asyncHandler(async (req, res) => res.json(publicUser(await currentUser(req)))),
);

authRouter.put(
  '/user',
  asyncHandler(async (req, res) => {
    const user = await currentUser(req);
    const { password, email, phone, data } = req.body || {};
    const sets = [];
    const params = [];
    if (password) {
      if (String(password).length < 6)
        throw new ApiError(422, 'Password should be at least 6 characters', { code: 'weak_password' });
      params.push(await bcrypt.hash(String(password), 10));
      sets.push(`encrypted_password = $${params.length}`);
    }
    if (email) { params.push(String(email).toLowerCase()); sets.push(`email = $${params.length}`); }
    if (phone) { params.push(phone); sets.push(`phone = $${params.length}`); }
    if (data) { params.push(JSON.stringify(data)); sets.push(`raw_user_meta_data = raw_user_meta_data || $${params.length}::jsonb`); }
    if (!sets.length) return res.json(publicUser(user));
    params.push(user.id);
    const updated = await one(
      `UPDATE auth.users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return res.json(publicUser(updated));
  }),
);

// ── POST /auth/v1/logout ─────────────────────────────────────────────
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.ctx.claims?.session_id) {
      await q('DELETE FROM auth.sessions WHERE id = $1', [req.ctx.claims.session_id]);
    } else if (req.ctx.userId) {
      await q('DELETE FROM auth.sessions WHERE user_id = $1', [req.ctx.userId]);
    }
    return res.status(204).send('');
  }),
);

// ── POST /auth/v1/recover  (resetPasswordForEmail) ───────────────────
authRouter.post(
  '/recover',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase();
    const user = await one('SELECT * FROM auth.users WHERE email = $1 AND deleted_at IS NULL', [email]);
    if (user) {
      const token = crypto.randomBytes(24).toString('base64url');
      await q('UPDATE auth.users SET recovery_token = $1, recovery_sent_at = now() WHERE id = $2', [token, user.id]);
      const redirect = req.body?.redirect_to || `${config.publicUrl}/reset-password`;
      const link = `${redirect}#recovery_token=${token}&type=recovery`;
      const { subject, html } = recoveryEmail(link);
      await sendMail({ to: email, subject, html });
    }
    // Always 200 — never leak whether the address exists.
    return res.json({});
  }),
);

// ── POST /auth/v1/verify  (exchange a recovery token for a session) ──
authRouter.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { type, token } = req.body || {};
    if (type !== 'recovery') throw badRequest(`unsupported verification type "${type}"`);
    const user = await one(
      `SELECT * FROM auth.users WHERE recovery_token = $1 AND recovery_sent_at > now() - interval '1 hour'`,
      [token],
    );
    if (!user) throw new ApiError(401, 'Token has expired or is invalid', { code: 'otp_expired' });
    await q('UPDATE auth.users SET recovery_token = NULL WHERE id = $1', [user.id]);
    return res.json(await newSession(user, req));
  }),
);

// ── POST /auth/v1/resend ─────────────────────────────────────────────
authRouter.post(
  '/resend',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase();
    const user = await one('SELECT * FROM auth.users WHERE email = $1', [email]);
    if (user) {
      const token = crypto.randomBytes(16).toString('hex');
      await q('UPDATE auth.users SET confirmation_token = $1, confirmation_sent_at = now() WHERE id = $2', [token, user.id]);
      const redirect = req.body?.redirect_to || config.publicUrl;
      const link = `${redirect}#confirmation_token=${token}&type=signup`;
      const { subject, html } = confirmationEmail(link);
      await sendMail({ to: email, subject, html });
    }
    return res.json({});
  }),
);
