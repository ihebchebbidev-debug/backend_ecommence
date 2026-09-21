// Self-healing schema at request time.
//
// If an API call touches a table or a column that does not exist yet, the
// backend creates it on the fly (shape taken from db/schema.sql when the object
// is declared there, otherwise inferred from the JSON payload) and retries the
// query once. Every change is written to the migration ledger so the history is
// auditable, and disabled with AUTO_SCHEMA=false in production.
import { pool } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { expectedSchema, columnsOf, tableExists } from './schemaModel.js';
import { record } from './autoMigrate.js';
import { registerPolicy, policyFor } from '../rest/policies.js';

const log = createLogger('autoschema');
const SAFE_NAME = /^[a-z_][a-z0-9_]{0,60}$/;
const inFlight = new Map(); // serialise DDL per table

export const autoSchemaEnabled = () => config.autoSchema;

function safe(name) {
  return typeof name === 'string' && SAFE_NAME.test(name);
}

/** Pick a PostgreSQL type for a JSON value. */
export function inferType(value) {
  if (value === null || value === undefined) return 'text';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'bigint' : 'numeric';
  if (Array.isArray(value) || typeof value === 'object') return 'jsonb';
  if (typeof value === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'uuid';
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(value)) return 'timestamptz';
  }
  return 'text';
}

async function serialise(key, fn) {
  while (inFlight.has(key)) await inFlight.get(key);
  const p = (async () => fn())();
  inFlight.set(key, p.catch(() => {}));
  try { return await p; } finally { inFlight.delete(key); }
}

/** A sensible access rule for a table nobody declared. */
function inferPolicy(table, row = {}) {
  if ('store_id' in row) return { scope: 'store', storeColumn: 'store_id' };
  if ('user_id' in row) return { scope: 'user', userColumn: 'user_id' };
  return { scope: 'admin' };
}

/** Create the table if it is missing. Returns true when DDL ran. */
export async function ensureTable(table, row = {}, schema = 'public') {
  if (!autoSchemaEnabled() || !safe(table)) return false;
  return serialise(`t:${schema}.${table}`, async () => {
    if (await tableExists(table, schema)) {
      if (!policyFor(table)) registerPolicy(table, inferPolicy(table, row), { auto: true });
      return false;
    }

    const declared = expectedSchema().get(`${schema}.${table}`);
    let ddl = declared?.ddl;
    if (!ddl) {
      const cols = Object.entries(row)
        .filter(([k]) => safe(k) && k !== 'id')
        .map(([k, v]) => `  "${k}" ${inferType(v)}`);
      ddl = [
        `CREATE TABLE IF NOT EXISTS ${schema}.${table} (`,
        [
          `  "id" uuid DEFAULT gen_random_uuid() NOT NULL`,
          ...cols,
          `  "created_at" timestamptz DEFAULT now() NOT NULL`,
          `  CONSTRAINT ${table}_pkey PRIMARY KEY ("id")`,
        ].join(',\n'),
        ');',
      ].join('\n');
    }

    await pool.query(ddl);
    await record(`auto-table:${schema}.${table}`, { kind: 'auto', statement: ddl });
    if (!policyFor(table)) registerPolicy(table, inferPolicy(table, row), { auto: true });
    log.warn('auto-created table', { table: `${schema}.${table}`, declared: Boolean(declared) });
    return true;
  });
}

/**
 * Create any column present in the payload but missing from the table.
 * Columns declared in db/schema.sql keep their declared type; anything else is
 * inferred from the value and always created nullable.
 */
export async function ensureColumns(table, rows, schema = 'public') {
  if (!autoSchemaEnabled() || !safe(table)) return [];
  const payload = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && typeof r === 'object');
  if (!payload.length) return [];

  const wanted = new Map();
  for (const row of payload) for (const [k, v] of Object.entries(row)) if (safe(k) && !wanted.has(k)) wanted.set(k, v);
  if (!wanted.size) return [];

  return serialise(`c:${schema}.${table}`, async () => {
    const existing = await columnsOf(table, schema);
    if (!existing.size) return [];
    const declared = expectedSchema().get(`${schema}.${table}`);
    const addedCols = [];

    for (const [name, value] of wanted) {
      if (existing.has(name)) continue;
      const decl = declared?.columns?.[name];
      const def = decl ? decl.ddl.replace(/\s+NOT NULL\b/i, '') : `"${name}" ${inferType(value)}`;
      const ddl = `ALTER TABLE ${schema}.${table} ADD COLUMN IF NOT EXISTS ${def}`;
      try {
        await pool.query(ddl);
        await record(`auto-column:${schema}.${table}.${name}`, { kind: 'auto', statement: ddl });
        addedCols.push(name);
        log.warn('auto-created column', { table: `${schema}.${table}`, column: name, declared: Boolean(decl) });
      } catch (err) {
        log.error('auto column failed', { table, column: name, code: err.code, message: err.message });
      }
    }
    return addedCols;
  });
}

/** Ensure both the table and the payload columns exist. */
export async function ensureShape(table, rows, schema = 'public') {
  const first = (Array.isArray(rows) ? rows[0] : rows) || {};
  await ensureTable(table, first, schema);
  return ensureColumns(table, rows, schema);
}

/**
 * Wrap a query: on "undefined table" (42P01) or "undefined column" (42703),
 * heal the schema from the payload and run it again exactly once.
 */
export async function withSelfHeal(table, rows, run) {
  try {
    return await run();
  } catch (err) {
    if (!autoSchemaEnabled() || !['42P01', '42703'].includes(err.code)) throw err;
    log.warn('query failed on missing schema object, healing', { table, code: err.code, message: err.message });
    await ensureShape(table, rows);
    return run();
  }
}
