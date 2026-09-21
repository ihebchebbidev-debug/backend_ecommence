// Automatic migrations.
//
// On every boot the backend:
//   1. ensures the migration ledger exists
//   2. applies db/*.sql (idempotent — CREATE TABLE IF NOT EXISTS) when the file
//      checksum has not been recorded yet
//   3. reconciles drift: creates any table and adds any column that db/*.sql
//      declares but the database is missing
//   4. logs a summary and refuses to serve traffic if the database is broken
//
// Result: pointing the backend at an empty database, or at a database that is
// one schema revision behind, is enough — it migrates itself.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pool } from '../db.js';
import { createLogger } from '../lib/logger.js';
import { dbDir, SQL_FILES, expectedSchema, schemaDrift } from './schemaModel.js';

const log = createLogger('migrate');

const LEDGER = `
CREATE TABLE IF NOT EXISTS public._schema_migrations (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  checksum    text,
  kind        text NOT NULL DEFAULT 'file',
  statement   text,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS _schema_migrations_name_idx ON public._schema_migrations (name);
`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export async function ensureLedger() {
  await pool.query(LEDGER);
}

async function alreadyApplied(name, checksum) {
  const { rows } = await pool.query(
    `SELECT 1 FROM public._schema_migrations WHERE name = $1 AND checksum = $2 LIMIT 1`,
    [name, checksum],
  );
  return rows.length > 0;
}

export async function record(name, { checksum = null, kind = 'file', statement = null } = {}) {
  await pool.query(
    `INSERT INTO public._schema_migrations (name, checksum, kind, statement) VALUES ($1, $2, $3, $4)`,
    [name, checksum, kind, statement],
  );
}

/** Apply the SQL files that have not been applied at their current checksum. */
export async function applyFiles({ force = false } = {}) {
  const applied = [];
  for (const file of SQL_FILES) {
    const full = path.join(dbDir, file);
    if (!fs.existsSync(full)) { log.warn('sql file missing, skipped', { file }); continue; }
    const sql = fs.readFileSync(full, 'utf8');
    const checksum = sha(sql);
    if (!force && await alreadyApplied(file, checksum)) { log.debug('already applied', { file, checksum }); continue; }
    const started = Date.now();
    try {
      await pool.query(sql);
      if (!(await alreadyApplied(file, checksum))) await record(file, { checksum });
      applied.push(file);
      log.info('applied sql file', { file, checksum, ms: Date.now() - started });
    } catch (err) {
      log.error('sql file failed', { file, checksum, code: err.code, message: err.message, detail: err.detail });
      throw err;
    }
  }
  return applied;
}

/** ADD COLUMN cannot enforce NOT NULL without a default on a populated table. */
function addColumnDdl(schema, table, col) {
  let def = col.ddl;
  if (!/DEFAULT/i.test(def)) def = def.replace(/\s+NOT NULL\b/i, '');
  return `ALTER TABLE ${schema}.${table} ADD COLUMN IF NOT EXISTS ${def}`;
}

/** Create missing tables / columns so the database matches db/*.sql exactly. */
export async function reconcileDrift() {
  const drift = await schemaDrift();
  const created = [];
  const added = [];

  for (const t of drift.missingTables) {
    try {
      await pool.query(t.ddl);
      await record(`create:${t.key}`, { kind: 'drift', statement: t.ddl });
      created.push(t.key);
      log.warn('created missing table', { table: t.key, source: t.file });
    } catch (err) {
      log.error('could not create missing table', { table: t.key, code: err.code, message: err.message });
    }
  }

  for (const c of drift.missingColumns) {
    const ddl = addColumnDdl(c.schema, c.table, c);
    try {
      await pool.query(ddl);
      await record(`column:${c.key}.${c.name}`, { kind: 'drift', statement: ddl });
      added.push(`${c.key}.${c.name}`);
      log.warn('added missing column', { table: c.key, column: c.name, type: c.type });
    } catch (err) {
      log.error('could not add missing column', { table: c.key, column: c.name, code: err.code, message: err.message });
    }
  }

  return { created, added, drift };
}

/** Full boot sequence. Returns a report; throws only if the DB is unusable. */
export async function autoMigrate({ reconcile = true } = {}) {
  const started = Date.now();
  await pool.query('SELECT 1');
  await ensureLedger();
  const applied = await applyFiles();
  const result = reconcile ? await reconcileDrift() : { created: [], added: [], drift: await schemaDrift() };
  // A recreated table comes back bare — re-running the (idempotent) files
  // restores its foreign keys, indexes and triggers.
  if (result.created.length) {
    log.warn('replaying sql files to restore constraints on recreated tables', { tables: result.created });
    await applyFiles({ force: true });
  }
  const after = await schemaDrift();

  const report = {
    ms: Date.now() - started,
    filesApplied: applied,
    tablesCreated: result.created,
    columnsAdded: result.added,
    expectedTables: after.expectedCount,
    liveTables: after.liveCount,
    stillMissingTables: after.missingTables.map((t) => t.key),
    stillMissingColumns: after.missingColumns.map((c) => `${c.key}.${c.name}`),
    upToDate: after.missingTables.length === 0 && after.missingColumns.length === 0,
  };

  if (report.upToDate) log.info('database up to date', { expectedTables: report.expectedTables, ms: report.ms });
  else log.error('database still out of sync after auto-migration', report);

  return report;
}
