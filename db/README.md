# nodejs_backend/db

PostgreSQL schema for the Node.js rewrite of the Supabase backend.

## Files

- `schema.sql` — all **70 tables**, **855 columns**, **73 foreign keys** + an index on every FK column.

## Apply it

```bash
createdb myapp
psql "postgresql://user:pass@localhost:5432/myapp" -f schema.sql
```

Verified: the file runs end-to-end on stock PostgreSQL 17 inside a single transaction
(`BEGIN … COMMIT`) and produces exactly 70 tables / 855 columns / 73 foreign keys.

## How it was built

Generated from `src/integrations/supabase/types.ts` (the authoritative list of tables,
columns, nullability and foreign keys of the live backend) merged with the documented
defaults from `complete_supabase_api_spec.md`.

## Notes / assumptions

- Only `pgcrypto` is required (for `gen_random_uuid()`). No Supabase-specific extensions,
  no `auth` schema, no RLS — authorization must be implemented in the Node.js layer.
- Columns that reference `auth.users` (`user_id`, `created_by`, `performed_by`, …) are plain
  `uuid` columns with **no** foreign key, since there is no `auth.users` table here. Point
  them at your own users table when you add one.
- Foreign keys use `ON DELETE CASCADE`. Change to `RESTRICT`/`SET NULL` where your business
  rules require it.
- Column types were derived from TypeScript types: `Json` → `jsonb`, `string[]` → `text[]`,
  `*_at` → `timestamptz`, money/measure names → `numeric`, counter names → `integer`,
  id/FK columns → `uuid`, everything else → `text`. Add `varchar(n)` limits, `CHECK`
  constraints and unique indexes (e.g. `platform_stores.slug`) as needed.
- Defaults for NOT NULL columns not documented in the spec are safe fallbacks
  (`''`, `0`, `false`, `'{}'`, `now()`).
