// OpenAPI 3.0 description of the whole backend, generated from the code itself:
// tables come from db/schema.sql, the access rules from rest/policies.js, the
// database functions from the rpc registry and the server functions from the
// edge-function registry. Nothing here is hand-maintained.
import { expectedSchema } from '../db/schemaModel.js';
import { policies } from '../rest/policies.js';
import { rpcRegistry } from '../rpc/index.js';
import { edgeFunctions } from '../functions/index.js';
import { config } from '../config.js';

const SCOPE_TEXT = {
  store: 'store members only (rows filtered by store_id)',
  user: 'the signed-in owner only',
  profile: 'the signed-in user\'s own profile row',
  catalog: 'readable by everyone',
  admin: 'admins only',
  denied: 'never reachable over the data API',
};

export function publicTables() {
  return [...expectedSchema().values()]
    .filter((t) => t.schema === 'public' && !t.table.startsWith('_'))
    .map((t) => t.table)
    .sort();
}

function tableMarkdown() {
  const rows = publicTables().map((t) => {
    const p = policies[t] || { scope: 'denied' };
    const notes = [];
    if (p.publicRead) notes.push('anonymous read when filtered by store_id');
    if (p.publicInsert) notes.push('anonymous insert');
    if (p.hidden?.length) notes.push(`hidden columns: ${p.hidden.join(', ')}`);
    return `| \`${t}\` | ${SCOPE_TEXT[p.scope] || p.scope} | ${notes.join('; ') || '—'} |`;
  });
  return ['| table | access | notes |', '| --- | --- | --- |', ...rows].join('\n');
}

const DESCRIPTION = `
Drop-in replacement for the Supabase API: same paths, same headers, same JSON and
the same error envelopes, running on plain PostgreSQL.

### Try it in three steps

1. **POST /auth/v1/signup** (or **/auth/v1/token?grant_type=password**) and copy
   \`access_token\` from the response.
2. Click **Authorize** at the top right and paste it.
3. Call anything below — the token decides which rows you can see.

A service-role token bypasses every access rule — server-side use only.

### Query syntax (data API)

\`?select=id,name&store_id=eq.<uuid>&status=in.(pending,paid)&order=created_at.desc&limit=20\`

Filters: \`eq, neq, gt, gte, lt, lte, like, ilike, in, is\` — \`*\` works as the
wildcard in \`like\`/\`ilike\`. Headers: \`Range\` for paging,
\`Prefer: count=exact\` for the total, \`Prefer: return=minimal\`,
\`Prefer: resolution=merge-duplicates\` for upserts,
\`Accept: application/vnd.pgrst.object+json\` for a single object.

<details>
<summary><b>All ${publicTables().length} tables and their access rules</b> (click to expand)</summary>

${tableMarkdown()}

</details>
`;

const errorSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' }, code: { type: 'string' },
    details: { type: 'string', nullable: true }, hint: { type: 'string', nullable: true },
  },
};

const errorResponse = (description) => ({
  description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const jsonBody = (example) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', additionalProperties: true }, example } },
});

export function buildSpec() {
  const tables = publicTables();
  const tableParam = {
    name: 'table', in: 'path', required: true,
    description: 'Table name — pick one from the list.',
    schema: { type: 'string', enum: tables, default: tables.includes('products') ? 'products' : tables[0] },
  };
  const selectParam = { name: 'select', in: 'query', schema: { type: 'string' }, example: '*', description: 'Columns to return.' };
  const orderParam = { name: 'order', in: 'query', schema: { type: 'string' }, example: 'created_at.desc' };
  const limitParam = { name: 'limit', in: 'query', schema: { type: 'integer' }, example: 20 };
  const offsetParam = { name: 'offset', in: 'query', schema: { type: 'integer' } };
  const filterParam = {
    name: 'filter', in: 'query', required: false, style: 'form', explode: true,
    schema: { type: 'object', additionalProperties: { type: 'string' } },
    description: 'Any column filter, e.g. `store_id=eq.<uuid>` or `status=in.(pending,paid)`.',
    example: { id: 'eq.00000000-0000-0000-0000-000000000000' },
  };
  const preferParam = {
    name: 'Prefer', in: 'header', schema: { type: 'string' },
    description: '`count=exact`, `return=minimal`, `return=representation`, `resolution=merge-duplicates`',
  };

  return {
    openapi: '3.0.3',
    info: {
      title: 'Backend API',
      version: '1.0.0',
      description: DESCRIPTION,
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
      { name: 'Health', description: 'Liveness and schema status.' },
      { name: 'Auth', description: 'Sign up, sign in, refresh, profile, sign out.' },
      { name: 'Data', description: 'Read and write any table (PostgREST-compatible).' },
      { name: 'Database functions', description: `${Object.keys(rpcRegistry).length} functions under /rest/v1/rpc.` },
      { name: 'Server functions', description: `${Object.keys(edgeFunctions).length} functions under /functions/v1.` },
      { name: 'Storage', description: 'Upload, download, list and delete files.' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Paste the `access_token` from /auth/v1/token.' },
      },
      schemas: { Error: errorSchema },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: { tags: ['Health'], summary: 'Liveness + database + schema status', security: [], responses: { 200: { description: 'ok' }, 503: errorResponse('database down') } },
      },
      '/health/schema': {
        get: { tags: ['Health'], summary: 'Expected vs live schema, last auto-migration', security: [], responses: { 200: { description: 'schema report' } } },
      },
      '/auth/v1/signup': {
        post: {
          tags: ['Auth'], summary: 'Create an account and return a session', security: [],
          requestBody: jsonBody({ email: 'you@example.com', password: 'super-secret', data: { full_name: 'Test User' } }),
          responses: { 200: { description: 'session + user' }, 400: errorResponse('invalid or already registered') },
        },
      },
      '/auth/v1/token': {
        post: {
          tags: ['Auth'], summary: 'Sign in (password) or refresh a session', security: [],
          parameters: [{ name: 'grant_type', in: 'query', required: true, schema: { type: 'string', enum: ['password', 'refresh_token'], default: 'password' } }],
          requestBody: jsonBody({ email: 'you@example.com', password: 'super-secret' }),
          responses: { 200: { description: 'access_token, refresh_token, user' }, 400: errorResponse('bad credentials') },
        },
      },
      '/auth/v1/user': {
        get: { tags: ['Auth'], summary: 'The signed-in user', responses: { 200: { description: 'user' }, 401: errorResponse('no session') } },
        put: {
          tags: ['Auth'], summary: 'Update email, password or metadata',
          requestBody: jsonBody({ data: { full_name: 'New Name' } }),
          responses: { 200: { description: 'user' }, 401: errorResponse('no session') },
        },
      },
      '/auth/v1/logout': { post: { tags: ['Auth'], summary: 'Revoke the current session', responses: { 204: { description: 'signed out' } } } },
      '/auth/v1/recover': { post: { tags: ['Auth'], summary: 'Request a password reset', security: [], requestBody: jsonBody({ email: 'you@example.com' }), responses: { 200: { description: 'always ok (no account leak)' } } } },
      '/auth/v1/verify': { post: { tags: ['Auth'], summary: 'Verify an OTP / recovery token', security: [], requestBody: jsonBody({ type: 'recovery', email: 'you@example.com', token: '123456' }), responses: { 200: { description: 'session' } } } },
      '/auth/v1/resend': { post: { tags: ['Auth'], summary: 'Resend a confirmation', security: [], requestBody: jsonBody({ type: 'signup', email: 'you@example.com' }), responses: { 200: { description: 'always ok' } } } },

      '/rest/v1/{table}': {
        get: {
          tags: ['Data'], summary: 'Read rows',
          parameters: [tableParam, selectParam, orderParam, limitParam, offsetParam, filterParam,
            { name: 'Range', in: 'header', schema: { type: 'string' }, example: '0-19' },
            preferParam,
            { name: 'Accept', in: 'header', schema: { type: 'string' }, description: '`application/vnd.pgrst.object+json` returns a single object.' }],
          responses: { 200: { description: 'rows' }, 206: { description: 'partial content (Range)' }, 400: errorResponse('bad query'), 401: errorResponse('no session'), 403: errorResponse('not allowed'), 404: errorResponse('unknown table') },
        },
        post: {
          tags: ['Data'], summary: 'Insert or upsert rows',
          description: 'Body may be one object or an array. Attributes with no column are created automatically when AUTO_SCHEMA is on.',
          parameters: [tableParam, preferParam, selectParam],
          requestBody: jsonBody({ id: '00000000-0000-0000-0000-000000000000', name: 'Example' }),
          responses: { 201: { description: 'created rows' }, 400: errorResponse('bad payload'), 403: errorResponse('not allowed') },
        },
        patch: {
          tags: ['Data'], summary: 'Update rows (a filter is required)',
          parameters: [tableParam, filterParam, preferParam, selectParam],
          requestBody: jsonBody({ name: 'Updated' }),
          responses: { 200: { description: 'updated rows' }, 400: errorResponse('missing filter'), 403: errorResponse('not allowed') },
        },
        delete: {
          tags: ['Data'], summary: 'Delete rows (a filter is required)',
          parameters: [tableParam, filterParam, preferParam],
          responses: { 200: { description: 'deleted rows' }, 400: errorResponse('missing filter'), 403: errorResponse('not allowed') },
        },
      },

      '/rest/v1/rpc/{fn}': {
        post: {
          tags: ['Database functions'], summary: 'Call a database function',
          parameters: [{
            name: 'fn', in: 'path', required: true,
            description: 'Function name — pick one from the list.',
            schema: { type: 'string', enum: Object.keys(rpcRegistry).sort(), default: 'is_active_user' },
          }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true }, example: {} } } },
          responses: { 200: { description: 'the function result' }, 401: errorResponse('no session'), 404: errorResponse('unknown function (PGRST202)') },
        },
      },

      '/functions/v1/{name}': {
        post: {
          tags: ['Server functions'], summary: 'Invoke a server function',
          description: `Public (no session needed): ${Object.entries(edgeFunctions).filter(([, f]) => !f.verifyJwt).map(([n]) => `\`${n}\``).join(', ')}. All others require a signed-in caller.`,
          parameters: [{
            name: 'name', in: 'path', required: true,
            schema: { type: 'string', enum: Object.keys(edgeFunctions).sort(), default: Object.keys(edgeFunctions)[0] },
          }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true }, example: {} } } },
          responses: { 200: { description: 'function result' }, 401: errorResponse('no session'), 404: errorResponse('unknown function') },
        },
      },

      '/storage/v1/object/{bucket}/{path}': {
        post: {
          tags: ['Storage'], summary: 'Upload a file',
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string', default: 'platform-assets' } },
            { name: 'path', in: 'path', required: true, schema: { type: 'string', default: 'demo/file.txt' } },
            { name: 'x-upsert', in: 'header', schema: { type: 'string', enum: ['true', 'false'] } },
          ],
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
          responses: { 200: { description: 'Key of the stored object' }, 401: errorResponse('no session'), 404: errorResponse('unknown bucket') },
        },
        get: {
          tags: ['Storage'], summary: 'Download a file (session required)',
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string', default: 'platform-assets' } },
            { name: 'path', in: 'path', required: true, schema: { type: 'string', default: 'demo/file.txt' } },
          ],
          responses: { 200: { description: 'file bytes' }, 404: errorResponse('not found') },
        },
        delete: {
          tags: ['Storage'], summary: 'Delete a file',
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string', default: 'platform-assets' } },
            { name: 'path', in: 'path', required: true, schema: { type: 'string', default: 'demo/file.txt' } },
          ],
          responses: { 200: { description: 'deleted' }, 404: errorResponse('not found') },
        },
      },
      '/storage/v1/object/public/{bucket}/{path}': {
        get: {
          tags: ['Storage'], summary: 'Download from a public bucket (no session)', security: [],
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string', default: 'platform-assets' } },
            { name: 'path', in: 'path', required: true, schema: { type: 'string', default: 'demo/file.txt' } },
          ],
          responses: { 200: { description: 'file bytes' }, 404: errorResponse('not found') },
        },
      },
      '/storage/v1/object/list/{bucket}': {
        post: {
          tags: ['Storage'], summary: 'List objects in a bucket',
          parameters: [{ name: 'bucket', in: 'path', required: true, schema: { type: 'string', default: 'platform-assets' } }],
          requestBody: jsonBody({ prefix: '', limit: 100 }),
          responses: { 200: { description: 'objects' } },
        },
      },
      '/storage/v1/bucket': {
        get: { tags: ['Storage'], summary: 'List buckets', responses: { 200: { description: 'buckets' } } },
      },
    },
  };
}
