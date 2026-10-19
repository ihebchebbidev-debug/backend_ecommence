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
import { seed } from './db/seed.js';
import { schemaDrift } from './db/schemaModel.js';
import { docsRouter } from './docs/router.js';
import { startAutomationWorker } from './lib/automationWebhooks.js';
import { checkUnsubscribeToken } from './lib/marketing.js';

const log = createLogger('server');

export const app = express();
// Behind Caddy/nginx/Docker the socket address is the proxy; trust private-network hops so req.ip is the
// real shopper (needed for IP blacklist, per-IP order limits and rate limits). Override with TRUST_PROXY.
app.set('trust proxy', process.env.TRUST_PROXY && !/^(true|\*)$/i.test(process.env.TRUST_PROXY) ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY) : 'loopback, linklocal, uniquelocal');

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


// Automatic https for seller domains: the web server asks before issuing a certificate.
// 200 only for an active, linked shop domain (with or without www); never reveals which shop.
app.get('/domain-allowed', async (req, res) => {
  try {
    const { default: domainsRpc } = await import('./rpc/domains.js');
    const slug = await domainsRpc.store_slug_for_domain({ p_domain: String(req.query.domain || '') }, { q: (sql, p) => pool.query(sql, p).then((r) => r.rows) });
    res.status(slug ? 200 : 404).end();
  } catch { res.status(404).end(); }
});

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

// One-click unsubscribe from seller email campaigns (link is HMAC-signed per recipient).
app.all('/email-unsubscribe', async (req, res) => {
  const r = String(req.query.r || ''), t = String(req.query.t || '');
  const page = (msg) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center;color:#111"><h2>${msg}</h2></body>`);
  if (!/^[0-9a-f-]{36}$/i.test(r) || !checkUnsubscribeToken(r, t)) return res.status(400) && page('Lien invalide');
  try {
    const rec = (await pool.query('SELECT store_id, email FROM public.store_email_recipients WHERE id=$1', [r])).rows[0];
    if (!rec) return page('Lien expiré');
    await pool.query('INSERT INTO public.store_email_unsubscribes(store_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rec.store_id, rec.email]);
    return page('Vous êtes désinscrit(e). Vous ne recevrez plus ces e-mails.');
  } catch { return res.status(500) && page('Erreur, réessayez plus tard'); }
});

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
  await seed(log);

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
  startAutomationWorker((sql, p) => pool.query(sql, p).then((r) => r.rows), log);
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
