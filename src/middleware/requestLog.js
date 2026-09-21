// Per-request logging: assigns a request id, logs completion with timing and
// status, and warns on slow requests. The id is echoed back as x-request-id so
// a client-reported problem can be found in the logs.
import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger.js';

const log = createLogger('http');
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 1000);

export function requestLog(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.id = id;
  req.log = log.child({ reqId: id });
  res.setHeader('x-request-id', id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const fields = {
      reqId: id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      query: req.originalUrl.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : undefined,
      status: res.statusCode,
      ms: Math.round(ms),
      role: req.ctx?.role,
      userId: req.ctx?.userId || undefined,
    };
    if (res.statusCode >= 500) log.error('request failed', fields);
    else if (res.statusCode >= 400) log.warn('request rejected', fields);
    else if (ms > SLOW_MS) log.warn('slow request', fields);
    else log.info('request', fields);
  });

  next();
}
