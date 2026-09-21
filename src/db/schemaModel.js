// The expected shape of the database, parsed straight out of db/*.sql, plus
// helpers to read the live shape from information_schema and diff the two.
// db/schema.sql is the single source of truth — nothing here is hand-maintained.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const dbDir = path.join(here, '..', '..', 'db');
export const SQL_FILES = ['schema.sql', 'auth_schema.sql', 'realtime.sql'];

const CREATE_TABLE = /CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\.([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi;

/** Split a CREATE TABLE body into top-level definition lines (paren aware). */
function splitDefs(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

let cached = null;

/** { 'public.orders': { schema, table, columns: { col: { name, type, ddl } }, ddl } } */
export function expectedSchema({ reload = false } = {}) {
  if (cached && !reload) return cached;
  const tables = new Map();

  for (const file of SQL_FILES) {
    const full = path.join(dbDir, file);
    if (!fs.existsSync(full)) continue;
    const sql = fs.readFileSync(full, 'utf8');
    for (const m of sql.matchAll(CREATE_TABLE)) {
      const [, schema, table, body] = m;
      const columns = {};
      for (const def of splitDefs(body)) {
        if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i.test(def)) continue;
        const nameMatch = def.match(/^"?([a-z0-9_]+)"?\s+([\s\S]+)$/i);
        if (!nameMatch) continue;
        const [, name, rest] = nameMatch;
        columns[name] = { name, type: rest.split(/\s+/)[0], ddl: def };
      }
      tables.set(`${schema}.${table}`, { schema, table, columns, ddl: m[0], file });
    }
  }

  cached = tables;
  return tables;
}

/** Live shape: same key format, from information_schema. */
export async function liveSchema() {
  const { rows } = await pool.query(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema IN ('public', 'auth', 'storage', 'realtime')
  `);
  const tables = new Map();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!tables.has(key)) tables.set(key, { schema: r.table_schema, table: r.table_name, columns: {} });
    tables.get(key).columns[r.column_name] = { name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' };
  }
  return tables;
}

/** Everything expected but absent in the database. */
export async function schemaDrift() {
  const expected = expectedSchema();
  const live = await liveSchema();
  const missingTables = [];
  const missingColumns = [];

  for (const [key, def] of expected) {
    const actual = live.get(key);
    if (!actual) { missingTables.push({ key, ...def }); continue; }
    for (const col of Object.values(def.columns)) {
      if (!actual.columns[col.name]) missingColumns.push({ key, schema: def.schema, table: def.table, ...col });
    }
  }

  return { missingTables, missingColumns, expectedCount: expected.size, liveCount: live.size };
}

/** True when the table physically exists right now. */
export async function tableExists(table, schema = 'public') {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return rows.length > 0;
}

/** Column names that exist right now. */
export async function columnsOf(table, schema = 'public') {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return new Set(rows.map((r) => r.column_name));
}
