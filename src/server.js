import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config, checkConfig } from './config.js';
import { pool } from './db.js';
import { authContext } from './middleware/auth.js';
import { requestLog } from './middleware/requestLog.js';
import { errorHandler } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { restRouter } from './rest/router.js';
import { rpcRouter } from './rpc/index.js';
import { authRouter } from './auth/router.js';
import { storageRouter } from './storage/router.js';
import { functionsRouter } from './functions/index.js';
import { attachRealtime } from './realtime/server.js';
import { autoMigrate } from './db/autoMigrate.js';
import { schemaDrift } from './db/schemaModel.js';
import { docsRouter } from './docs/router.js';

const log = createLogger('server');

export const app = express();

app.disable('x-powered-by');
// Any origin is allowed. The origin is reflected (not "*") so that credentialed
// requests keep working, and every requested header is echoed back.
app.use(
  cors({
    origin: true,
    credentials: true,
    // No allowedHeaders list → the CORS preflight reflects whatever the browser asks for.
    exposedHeaders: [
      'content-range', 'x-total-count', 'content-length', 'content-type', 'x-request-id',
    ],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
  }),
);
app.options('*', cors({ origin: true, credentials: true, maxAge: 86400 }));

// Raw body for signature-verified webhooks, JSON everywhere else.
app.use('/functions/v1/whatsapp-webhook', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/plain' }));

app.use(authContext);
app.use(requestLog);

// Interactive API explorer on the root URL.
app.use(docsRouter);


app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up', schema: lastMigration?.upToDate ?? null, time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});

// Schema health: what the code expects vs what the database has.
app.get('/health/schema', async (_req, res, next) => {
  try {
    const drift = await schemaDrift();
    res.json({
      upToDate: drift.missingTables.length === 0 && drift.missingColumns.length === 0,
      expectedTables: drift.expectedCount,
      liveTables: drift.liveCount,
      missingTables: drift.missingTables.map((t) => t.key),
      missingColumns: drift.missingColumns.map((c) => `${c.key}.${c.name}`),
      lastMigration,
    });
  } catch (err) { next(err); }
});

// Bearer tokens that fail verification must be rejected before any data access.
const rejectBadJwt = (req, _res, next) => next(req.authError || undefined);

app.use('/auth/v1', authRouter);
app.use('/rest/v1/rpc', rejectBadJwt, rpcRouter);
app.use('/rest/v1', rejectBadJwt, restRouter);
app.use('/storage/v1', storageRouter);
app.use('/functions/v1', functionsRouter);

app.use((_req, res) => res.status(404).json({ message: 'Not Found', code: '404', details: null, hint: null }));
app.use(errorHandler);

export const server = http.createServer(app);
attachRealtime(server);

export let lastMigration = null;

/** Run the boot migration once. Safe to call from tests before serving. */
export async function bootstrap({ force = false } = {}) {
  const { fatal, warnings } = checkConfig();
  for (const w of warnings) log.warn(w);
  if (fatal.length) {
    for (const f of fatal) log.fatal(f);
    throw new Error(`unsafe configuration: ${fatal.join('; ')}`);
  }

  if (!config.autoMigrate && !force) {
    log.warn('auto-migration disabled (AUTO_MIGRATE=false)');
    return null;
  }
  lastMigration = await autoMigrate();

  // Buckets declared in STORAGE_BUCKETS exist from the start; any other bucket
  // is created by its first upload.
  for (const bucket of config.storageBuckets) {
    await pool
      .query('INSERT INTO storage.buckets (id, name, public) VALUES ($1, $1, true) ON CONFLICT (id) DO NOTHING', [bucket])
      .catch((err) => log.warn('could not ensure bucket', { bucket, message: err.message }));
  }

  // Publish live changes for every configured table (orders by default).
  for (const table of config.realtimeTables) {
    const ok = await pool
      .query('SELECT public.enable_realtime($1) AS ok', [table])
      .then((r) => r.rows[0]?.ok)
      .catch((err) => {
        log.warn('could not enable realtime', { table, message: err.message });
        return false;
      });
    if (!ok) log.warn('realtime not enabled for table', { table });
  }

  return lastMigration;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  try {
    await bootstrap();
  } catch (err) {
    log.fatal('database not usable, refusing to start', { message: err.message, code: err.code });
    process.exit(1);
  }
  server.listen(config.port, () => {
    log.info('listening', { url: `http://localhost:${config.port}`, env: config.env, autoSchema: config.autoSchema });
  });
  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));
  process.on('uncaughtException', (err) => log.fatal('uncaught exception', { message: err.message, stack: err.stack }));
}
