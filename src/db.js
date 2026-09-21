import pg from 'pg';
import { config } from './config.js';

// Supabase returns numeric/bigint as JS numbers in JSON. node-postgres returns
// them as strings by default — align the behaviour so response shapes match.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[pg] idle client error', err.message));

/** Run a query, return rows. */
export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Run a query, return the first row or null. */
export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] ?? null;
}

/** Run a callback inside a transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      raw: client,
      q: async (t, p = []) => (await client.query(t, p)).rows,
      one: async (t, p = []) => (await client.query(t, p)).rows[0] ?? null,
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
