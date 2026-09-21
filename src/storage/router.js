// /storage/v1/* — replaces Supabase Storage. Files land on disk under
// STORAGE_DIR and are served publicly; the stored object path is what the app
// keeps in its own tables.
//
// Buckets and folders are created on demand: the first upload to a bucket or a
// nested path creates the bucket row and every missing directory.
//
// Write access:
//   • service role                      → any bucket
//   • platform admins                   → any bucket
//   • any other signed-in user          → every bucket EXCEPT the admin-only
//                                         ones (config.adminOnlyBuckets), and
//                                         only under their own `<user-id>/…`
//                                         prefix, so users cannot overwrite
//                                         each other's files.
//   • anonymous                         → never
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, ApiError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';

export const storageRouter = express.Router();

const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

// Uploads arrive either as a raw body (server-side fetch) or as multipart.
// @supabase/supabase-js appends the blob under an EMPTY field name, which
// busboy/multer reject outright — so the multipart body is parsed here.
const rawBody = express.raw({ type: '*/*', limit: `${Math.ceil(config.maxUploadBytes / (1024 * 1024))}mb` });

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundary) return null;
  const sep = Buffer.from(`--${(boundary[1] || boundary[2]).trim()}`);
  let start = buffer.indexOf(sep);
  if (start === -1) return null;
  let best = null;
  while (start !== -1) {
    const bodyStart = buffer.indexOf('\r\n\r\n', start);
    if (bodyStart === -1) break;
    const next = buffer.indexOf(sep, bodyStart);
    if (next === -1) break;
    const headers = buffer.slice(start + sep.length, bodyStart).toString('utf8');
    const body = buffer.slice(bodyStart + 4, next - 2); // strip the trailing CRLF
    const mimetype = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim();
    const hasFilename = /filename=/i.test(headers);
    // The file part is the one with a filename or its own content-type; the
    // last such part wins (cacheControl/upsert fields carry neither).
    if (hasFilename || mimetype) best = { buffer: body, size: body.length, mimetype };
    else if (!best) best = { buffer: body, size: body.length, mimetype: undefined };
    start = next;
  }
  return best;
}

const safeKey = (key) => {
  const clean = path.posix.normalize(String(key || '')).replace(/^\/+/, '');
  if (!clean || clean.startsWith('..') || clean.includes('../')) throw badRequest('Invalid key');
  return clean;
};

const diskPath = (bucket, key) => path.join(path.resolve(config.storageDir), bucket, key);

const publicUrl = (bucket, key) =>
  `${config.publicUrl}/storage/v1/object/public/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

function assertBucketName(bucket) {
  if (!BUCKET_RE.test(String(bucket || ''))) throw badRequest('Invalid bucket name', { code: 'InvalidBucketName' });
}

/** Read path: the bucket must already exist. */
async function requireBucket(bucket) {
  assertBucketName(bucket);
  const row = await one('SELECT id, public FROM storage.buckets WHERE id = $1', [bucket]);
  if (!row) throw notFound('Bucket not found', { code: 'NoSuchBucket' });
  return row;
}

/** Write path: create the bucket (and its directory) on first use. */
async function ensureBucket(bucket) {
  assertBucketName(bucket);
  await q(
    `INSERT INTO storage.buckets (id, name, public) VALUES ($1, $1, true) ON CONFLICT (id) DO NOTHING`,
    [bucket],
  );
  await fs.mkdir(path.join(path.resolve(config.storageDir), bucket), { recursive: true });
  return bucket;
}

/**
 * Authorize a write (upload or delete) and return the caller id.
 * Admin-only buckets stay admin-only; everyone else writes under their own id.
 */
async function requireWriteAccess(req, bucket, key) {
  if (req.ctx.isServiceRole) return null;
  const userId = req.ctx.userId;
  if (!userId) throw unauthorized('new row violates row-level security policy');
  if (await req.ctx.isAnyAdmin()) return userId;
  if (config.adminOnlyBuckets.includes(bucket)) {
    throw forbidden(`Bucket "${bucket}" is writable by platform admins only`);
  }
  if (key && !`${key}/`.startsWith(`${userId}/`)) {
    throw forbidden(`Upload path must start with "${userId}/"`);
  }
  return userId;
}

async function writeObject(req, bucket, key, file, upsert) {
  const existing = await one('SELECT id FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, key]);
  if (existing && !upsert) throw new ApiError(409, 'The resource already exists', { code: 'Duplicate' });

  const dest = diskPath(bucket, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, file.buffer);

  await q(
    `INSERT INTO storage.objects (bucket_id, name, owner, size, mime_type, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (bucket_id, name) DO UPDATE
       SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type,
           metadata = EXCLUDED.metadata, updated_at = now()`,
    [
      bucket,
      key,
      req.ctx.userId,
      file.size,
      file.mimetype || 'application/octet-stream',
      JSON.stringify({ mimetype: file.mimetype, size: file.size, cacheControl: req.headers['cache-control'] || '3600' }),
    ],
  );
  // `path` is what the app stores in its own tables; publicUrl is a convenience.
  return {
    Id: key,
    Key: `${bucket}/${key}`,
    path: key,
    fullPath: `${bucket}/${key}`,
    bucket,
    size: file.size,
    mimeType: file.mimetype || 'application/octet-stream',
    publicUrl: publicUrl(bucket, key),
  };
}

// ── upload / update ──────────────────────────────────────────────────
const uploadHandler = asyncHandler(async (req, res) => {
  const bucket = req.params.bucket;
  const key = safeKey(req.params[0]);
  await requireWriteAccess(req, bucket, key);
  await ensureBucket(bucket); // bucket + folders created on first upload
  const ct = String(req.headers['content-type'] || '');
  let file = null;
  if (Buffer.isBuffer(req.body) && req.body.length) {
    file = ct.startsWith('multipart/')
      ? parseMultipart(req.body, ct)
      : { buffer: req.body, size: req.body.length, mimetype: ct.split(';')[0] || undefined };
  } else if (typeof req.body === 'string' && req.body.length) {
    const buf = Buffer.from(req.body);
    file = { buffer: buf, size: buf.length, mimetype: ct.split(';')[0] || undefined };
  } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
    // The global JSON parser already consumed a JSON upload body.
    const buf = Buffer.from(JSON.stringify(req.body));
    file = { buffer: buf, size: buf.length, mimetype: 'application/json' };
  }
  if (!file?.buffer?.length) throw badRequest('No file provided');
  if (file.size > config.maxUploadBytes) {
    throw new ApiError(413, `File exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB limit`, {
      code: 'PayloadTooLarge',
    });
  }
  const upsert = req.method === 'PUT' || String(req.headers['x-upsert']).toLowerCase() === 'true';
  return res.status(200).json(await writeObject(req, bucket, key, file, upsert));
});

storageRouter.post('/object/:bucket/*', rawBody, uploadHandler);
storageRouter.put('/object/:bucket/*', rawBody, uploadHandler);

// ── public URL (buckets are public by default) ───────────────────────
// Registered BEFORE /object/:bucket/* so "public" is never read as a bucket.
storageRouter.get(
  '/object/public/:bucket/*',
  asyncHandler(async (req, res) => {
    const bucket = req.params.bucket;
    await requireBucket(bucket);
    const key = safeKey(req.params[0]);
    const row = await one('SELECT mime_type FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, key]);
    if (!row) throw notFound('Object not found', { code: 'NoSuchKey' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(row.mime_type || 'application/octet-stream');
    return res.sendFile(diskPath(bucket, key));
  }),
);

// ── download (authenticated) ─────────────────────────────────────────
storageRouter.get(
  '/object/:bucket/*',
  asyncHandler(async (req, res) => {
    const bucket = req.params.bucket;
    await requireBucket(bucket);
    const key = safeKey(req.params[0]);
    const row = await one('SELECT * FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, key]);
    if (!row) throw notFound('Object not found', { code: 'NoSuchKey' });
    res.type(row.mime_type || 'application/octet-stream');
    return res.sendFile(diskPath(bucket, key));
  }),
);

// ── remove ───────────────────────────────────────────────────────────
storageRouter.delete(
  '/object/:bucket',
  asyncHandler(async (req, res) => {
    const bucket = req.params.bucket;
    await requireBucket(bucket);
    const prefixes = (req.body?.prefixes || []).map(safeKey);
    if (!prefixes.length) throw badRequest('prefixes is required');
    for (const key of prefixes) await requireWriteAccess(req, bucket, key);
    const removed = await q(
      'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[]) RETURNING name, bucket_id',
      [bucket, prefixes],
    );
    await Promise.all(removed.map((r) => fs.rm(diskPath(bucket, r.name), { force: true }).catch(() => {})));
    return res.json(removed.map((r) => ({ name: r.name, bucket_id: r.bucket_id })));
  }),
);

storageRouter.delete(
  '/object/:bucket/*',
  asyncHandler(async (req, res) => {
    const bucket = req.params.bucket;
    await requireBucket(bucket);
    const key = safeKey(req.params[0]);
    await requireWriteAccess(req, bucket, key);
    await q('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, key]);
    await fs.rm(diskPath(bucket, key), { force: true }).catch(() => {});
    return res.json({ message: 'Successfully deleted' });
  }),
);

// ── list ─────────────────────────────────────────────────────────────
storageRouter.post(
  '/object/list/:bucket',
  asyncHandler(async (req, res) => {
    const bucket = req.params.bucket;
    await requireBucket(bucket);
    const { prefix = '', limit = 100, offset = 0, sortBy } = req.body || {};
    const col = ['name', 'created_at', 'updated_at'].includes(sortBy?.column) ? sortBy.column : 'name';
    const dir = sortBy?.order === 'desc' ? 'DESC' : 'ASC';
    const rows = await q(
      `SELECT id, name, created_at, updated_at, metadata FROM storage.objects
       WHERE bucket_id = $1 AND name LIKE $2 ORDER BY ${col} ${dir} LIMIT $3 OFFSET $4`,
      [bucket, `${prefix}%`, Number(limit), Number(offset)],
    );
    return res.json(
      rows.map((r) => ({
        name: r.name,
        id: r.id,
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_accessed_at: r.updated_at,
        metadata: r.metadata,
      })),
    );
  }),
);

// ── buckets ──────────────────────────────────────────────────────────
storageRouter.get(
  '/bucket',
  asyncHandler(async (_req, res) => res.json(await q('SELECT * FROM storage.buckets ORDER BY id'))),
);
