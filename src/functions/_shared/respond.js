// Helpers shared by the ported edge functions so every response matches what
// the Deno originals returned (same JSON keys, same status codes).
import { serviceContext } from '../../lib/context.js';

export const json = (res, data, status = 200) => res.status(status).json(data);

/** The service-role client the Deno functions created with the service key. */
export const service = () => serviceContext();

/** Reject non-POST callers the way the Deno functions did. */
export function methodGuard(req, res, methods = ['POST']) {
  if (methods.includes(req.method)) return false;
  res.status(405).json({ error: 'Method not allowed' });
  return true;
}

/** Shared account guard: deleted / suspended profiles cannot call functions. */
export async function assertAccountUsable(ctx, res) {
  const p = await ctx.profile();
  if (p?.deleted_at || p?.status === 'deleted') { json(res, { error: 'Compte supprimé' }, 403); return false; }
  if (p?.suspended_at || p?.status === 'suspended') { json(res, { error: 'Compte suspendu' }, 403); return false; }
  return true;
}

export const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket?.remoteAddress || null;
