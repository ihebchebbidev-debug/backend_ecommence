// Manual migration entry point. Does exactly what the server does on boot:
// applies db/*.sql and then creates any table/column declared in db/schema.sql
// that the database is still missing.
//   DATABASE_URL=... node scripts/migrate.js
import { autoMigrate } from '../src/db/autoMigrate.js';
import { pool } from '../src/db.js';

try {
  const report = await autoMigrate();
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  process.exit(report.upToDate ? 0 : 1);
} catch (err) {
  console.error(`[migrate] failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}
