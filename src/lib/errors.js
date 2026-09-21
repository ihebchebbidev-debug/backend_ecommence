// PostgREST-compatible error envelope: { message, code, details, hint }.
// The Supabase JS client surfaces exactly these four fields on `error`.
import { logger } from './logger.js';

export class ApiError extends Error {
  constructor(status, message, { code = null, details = null, hint = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

export const badRequest = (m, o) => new ApiError(400, m, { code: '22023', ...o });
export const unauthorized = (m = 'Invalid authentication credentials', o) =>
  new ApiError(401, m, { code: '401', ...o });
export const forbidden = (m = 'permission denied', o) => new ApiError(403, m, { code: '42501', ...o });
export const notFound = (m = 'Not Found', o) => new ApiError(404, m, { code: 'PGRST116', ...o });
export const conflict = (m, o) => new ApiError(409, m, { code: '23505', ...o });

/** Map a raw PostgreSQL error onto the PostgREST status codes. */
export function fromPgError(err) {
  const map = { '23505': 409, '23503': 409, '23514': 400, '22P02': 400, '42501': 403, '42703': 400, '42P01': 404 };
  const status = map[err.code] || 400;
  return new ApiError(status, err.message, {
    code: err.code || null,
    details: err.detail || null,
    hint: err.hint || null,
  });
}

export function errorHandler(err, req, res, _next) {
  const log = req?.log || logger;
  const where = { reqId: req?.id, method: req?.method, path: req?.originalUrl?.split('?')[0], role: req?.ctx?.role };
  const e = err instanceof ApiError ? err : err.code && err.severity ? fromPgError(err) : null;

  if (e) {
    const fields = { ...where, status: e.status, code: e.code, details: e.details, hint: e.hint, message: e.message };
    if (e.status >= 500) log.error('request error', fields);
    else log.warn('request error', fields);
    return res
      .status(e.status)
      .json({ message: e.message, code: e.code, details: e.details, hint: e.hint });
  }

  log.error('unhandled error', { ...where, message: err?.message, stack: err?.stack });
  return res
    .status(500)
    .json({ message: err.message || 'Internal Server Error', code: '500', details: null, hint: null });
}

/** Wrap an async express handler so rejections reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
