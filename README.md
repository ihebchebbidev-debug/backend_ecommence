# nodejs_backend

Node.js + PostgreSQL port of the Supabase backend: data API (`/rest/v1`), database
functions (`/rest/v1/rpc`), auth (`/auth/v1`), file storage (`/storage/v1`), server
functions (`/functions/v1`) and live updates (`/realtime/v1/websocket`).

```bash
bun install                      # or npm install
export DATABASE_URL=postgresql://user:pass@host:5432/appdb
npm start                        # migrates itself, then serves on :8000
npm test                         # full automatic test suite (73 checks)
```

## Interactive API explorer

Open the backend's root URL in a browser (`http://localhost:8000/`, also `/docs`):
a Swagger UI page generated from the code itself — every table, every database
function, every server function, storage and auth. Sign in with
`POST /auth/v1/token?grant_type=password`, press **Authorize**, paste the
`access_token` and call any endpoint straight from the page. The raw OpenAPI 3
document is at `/openapi.json`, so it also imports into Postman or Insomnia.

The table list shows each table's access rule (store members, owner only, admin
only, public storefront read, never reachable) and any hidden credential columns.

## Automatic migrations

Nothing has to be applied by hand. On **every boot** the server:

1. creates the migration ledger `public._schema_migrations` if needed
2. applies `db/schema.sql`, `db/auth_schema.sql`, `db/realtime.sql` when their
   checksum has not been recorded yet (all three files are fully re-runnable)
3. compares `db/schema.sql` against `information_schema` and **creates every
   missing table and adds every missing column** — so shipping a new column only
   means editing `db/schema.sql`
4. replays the SQL files when a table had to be recreated, restoring its foreign
   keys, indexes and triggers
5. logs a summary and **refuses to start** if the database is still unusable

Pointing the backend at a brand-new empty database is enough; it builds all 70
tables, the auth schema and the storage schema on its own.

Check the state at any time:

```
GET /health          → { status, db, schema: true|false }
GET /health/schema   → expected vs live tables, missing tables, missing columns
```

## Self-healing schema at request time

If a request touches something that does not exist yet, the backend creates it
and retries the query once:

| Situation | Behaviour |
| --- | --- |
| Payload attribute with no column | Column added. Type from `db/schema.sql` when declared there, otherwise inferred from the value (`boolean`, `bigint`, `numeric`, `jsonb`, `uuid`, `timestamptz`, `text`). Always nullable, so existing rows stay valid. |
| Table declared in `db/schema.sql` but dropped | Table recreated from its declaration. |
| Table nobody declared | Created only for the **service role**, with `id`/`created_at` and the payload columns. A normal session still gets `42P01`. |
| Query fails with `42P01` / `42703` | Schema healed from the payload, query retried once. |

Identifiers are validated against `^[a-z_][a-z0-9_]{0,60}$`, so no payload key can
ever become SQL. Every change is written to `_schema_migrations` (`kind = 'auto'`)
together with the exact DDL that ran.

Turn either mechanism off with `AUTO_MIGRATE=false` / `AUTO_SCHEMA=false`
(recommended for a locked-down production database).

## Logging

Structured logs, one JSON object per event in production and colour-coded lines in
development (`LOG_FORMAT=json|pretty`, `LOG_LEVEL=trace…fatal`).

- every request gets an id, echoed back as `x-request-id` and attached to every
  log line for that request
- 4xx logs as `warn`, 5xx and unhandled errors as `error` with the stack
- requests slower than `SLOW_REQUEST_MS` (default 1000) log as `slow request`
- schema changes log as `warn` with the table and column involved
- anything whose key looks like a credential (`password`, `token`, `secret`,
  `apikey`, `authorization`, `otp`, `hash`, …) is replaced with `[redacted]`

## Tests

```bash
DATABASE_URL=… npm test              # everything
DATABASE_URL=… npm test -- --only=autoschema
```

Groups: `migration` (fresh install, idempotency, dropped column/table recovery),
`health`, `auth` (12 checks), `rest` (filters, ordering, paging, count, upsert,
single-object, error envelopes, permission isolation), `autoschema`, `rpc` (every
registered function is reachable), `storage`, `functions` (public/protected
matrix), `realtime` (a real INSERT arriving on a subscribed socket), `cleanup`.
The suite is self-contained: it migrates the database, creates its own account and
store, and removes everything it created.

```bash
npm run test:static                   # no database needed
```

`test:static` checks the code alone: every module imports, no RPC is implemented
twice, every RPC and edge function is callable, `db/schema.sql` has no duplicate
tables and `enable_realtime()` exists.

## Emails

Password reset and sign-up confirmation are sent for real. Set **one** of:

- `RESEND_API_KEY` (+ `EMAIL_FROM`), or
- `EMAIL_WEBHOOK_URL` (+ optional `EMAIL_WEBHOOK_SECRET`, sent as
  `x-webhook-secret`) to post `{ to, subject, html, text }` to your own sender.

With neither set the message is logged in development; in production the server
refuses to boot.

## Storage

Uploads are stored on disk under `STORAGE_DIR` and the **path** is what the app
keeps (`<bucket>/<user-id>/…`); the upload response returns `Key` and `publicUrl`.

- Buckets in `STORAGE_BUCKETS` exist from boot; any other bucket — and every
  folder inside it — is created automatically by its first upload.
- Buckets in `STORAGE_ADMIN_BUCKETS` accept writes from platform admins only.
- For other buckets a signed-in user writes and deletes only under their own
  `<user-id>/…` prefix. The service role bypasses this; anonymous callers never
  write. `MAX_UPLOAD_BYTES` caps file size (50 MB by default).

## Realtime

Any table listed in `REALTIME_TABLES` publishes INSERT/UPDATE/DELETE to
subscribed sockets — the server calls `public.enable_realtime(table)` at boot.

## Startup safety

`checkConfig()` runs before serving. In production the server refuses to start
with a missing/placeholder `JWT_SECRET`, a placeholder `DATABASE_URL`, or no
email provider, and `DEV_OTP_ALLOWED` is always ignored.

