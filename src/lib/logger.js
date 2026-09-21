// Structured logger. One JSON line per event in production, coloured
// human-readable lines in development. Never logs secret material.
import { config } from '../config.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || (config.env === 'test' ? 'warn' : 'info')).toLowerCase()] ?? 30;
const pretty = process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'pretty' : config.env !== 'production';

const COLORS = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[35m' };
const RESET = '\x1b[0m';

const SECRET_KEY = /(password|secret|token|apikey|api_key|authorization|credential|otp|hash|iv)/i;

/** Deep-redact anything that smells like a credential before it reaches a log. */
export function redact(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function emit(level, scope, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const payload = { time: new Date().toISOString(), level, scope, msg, ...redact(fields || {}) };
  const line = pretty
    ? `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${msg}${
        fields && Object.keys(fields).length ? ` ${JSON.stringify(redact(fields))}` : ''
      }`
    : JSON.stringify(payload);
  (LEVELS[level] >= 40 ? process.stderr : process.stdout).write(`${line}\n`);
}

/** Create a logger bound to a scope (module name) and optional sticky fields. */
export function createLogger(scope, base = {}) {
  const make = (level) => (msg, fields) => emit(level, scope, msg, { ...base, ...fields });
  return {
    scope,
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    /** Derive a logger that carries extra fields (e.g. a request id). */
    child: (fields) => createLogger(scope, { ...base, ...fields }),
  };
}

export const logger = createLogger('app');
