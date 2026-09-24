// /rest/v1/:table — PostgREST-compatible data API.
// Response shapes, status codes and the `Prefer` / `Range` / `Accept` header
// behaviour match what @supabase/supabase-js expects.
import express from 'express';
import { pool } from '../db.js';
import { asyncHandler, ApiError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { policyFor } from './policies.js';
import { buildQuery, parseSelect, parseRange, ident } from './queryBuilder.js';
import { autoSchemaEnabled, ensureShape, ensureColumns, ensureTable, withSelfHeal } from '../db/autoSchema.js';
import { expectedSchema } from '../db/schemaModel.js';

export const restRouter = express.Router();

/** Build the row-level restriction for a table + operation. */
async function scopeFilter(ctx, table, policy, op, query) {
  if (ctx.isServiceRole) return { where: [], params: [] };
  const isAdmin = await ctx.isSuperAdmin();

  switch (policy.scope) {
    case 'denied':
      throw forbidden(`table "${table}" is not exposed over the data API`);

    case 'catalog':
      if (op === 'read') return { where: [], params: [] };
      if (!isAdmin) throw forbidden('admin role required');
      return { where: [], params: [] };

    case 'admin':
      if (!(await ctx.isAnyAdmin())) throw forbidden('admin role required');
      return { where: [], params: [] };

    case 'profile':
      if (isAdmin) return { where: [], params: [] };
      if (!ctx.userId) throw forbidden('JWT required');
      return { where: [`"id" = $1`], params: [ctx.userId] };

    case 'user': {
      if (isAdmin) return { where: [], params: [] };
      if (!ctx.userId) throw forbidden('JWT required');
      if (op !== 'read' && policy.writeRoles && policy.writeRoles.length === 0)
        throw forbidden('read-only table');
      if (policy.alsoStore) {
        const ids = await ctx.userStoreIds();
        return {
          where: [`("${policy.userColumn}" = $1 OR "${policy.alsoStore}" = ANY($2::uuid[]))`],
          params: [ctx.userId, ids],
        };
      }
      return { where: [`"${policy.userColumn}" = $1`], params: [ctx.userId] };
    }

    case 'store': {
      if (isAdmin) return { where: [], params: [] };
      const col = policy.storeColumn;
      const requested = requestedStoreId(query, col);

      // Anonymous storefront reads: allowed only when the query pins one store.
      if (!ctx.userId) {
        if (op === 'read' && policy.publicRead && requested)
          return await publicScope(ctx, policy, col, requested);
        // The storefront resolves a store by its public slug (platform_stores
        // only): pin the row by slug, still requiring an active store.
        if (op === 'read' && policy.publicRead && col === 'id') {
          const slug = eqValue(query.slug);
          if (slug) {
            return {
              where: [`"slug" = $1`, `status = 'active'`, `deleted_at IS NULL`],
              params: [slug],
            };
          }
        }
        if (op === 'insert' && policy.publicInsert) return { where: [], params: [] };
        throw forbidden('JWT required');
      }

      const ids = await ctx.userStoreIds();
      if (op !== 'read') {
        if (policy.writeRoles && policy.writeRoles.length === 0) throw forbidden('read-only table');
        if (requested && policy.writeRoles) await ctx.assertStoreAccess(requested, policy.writeRoles);
      }
      if (!col) {
        // Child table (product_bundles / product_options / product_reviews).
        return {
          where: [
            `"${policy.parent.column}" IN (SELECT id FROM public.${policy.parent.table} WHERE store_id = ANY($1::uuid[]))`,
          ],
          params: [ids],
        };
      }
      return { where: [`"${col}" = ANY($1::uuid[])`], params: [ids] };
    }

    default:
      throw forbidden(`no policy for table "${table}"`);
  }
}

async function publicScope(_ctx, policy, col, storeId) {
  if (!col) {
    return {
      where: [`"${policy.parent.column}" IN (SELECT id FROM public.${policy.parent.table} WHERE store_id = $1)`],
      params: [storeId],
    };
  }
  return {
    where: [`"${col}" = $1`, `EXISTS (SELECT 1 FROM public.platform_stores s WHERE s.id = $1 AND s.status = 'active' AND s.deleted_at IS NULL)`],
    params: [storeId],
  };
}

function eqValue(raw) {
  if (!raw) return null;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const m = String(v).match(/^eq\.(.+)$/);
  return m ? m[1] : null;
}

function requestedStoreId(query, col) {
  const key = col === 'id' ? 'id' : 'store_id';
  return eqValue(query[key]);
}

function stripHidden(rows, policy, ctx) {
  if (ctx.isServiceRole || !policy.hidden?.length) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const c of policy.hidden) delete copy[c];
    return copy;
  });
}

function preferences(req) {
  const prefer = String(req.headers.prefer || '');
  return {
    representation: prefer.includes('return=representation'),
    minimal: prefer.includes('return=minimal'),
    count: /count=(exact|planned|estimated)/.exec(prefer)?.[1] || null,
    resolution: prefer.includes('resolution=merge-duplicates')
      ? 'merge'
      : prefer.includes('resolution=ignore-duplicates')
        ? 'ignore'
        : null,
  };
}

/** `Accept: application/vnd.pgrst.object+json` → single object, 406 when not exactly one row. */
function wantsSingle(req) {
  return String(req.headers.accept || '').includes('vnd.pgrst.object');
}

function respond(req, res, rows, { status = 200, total = null, offset = 0 } = {}) {
  if (total !== null) {
    const to = rows.length ? offset + rows.length - 1 : 0;
    res.set('Content-Range', `${offset}-${to}/${total}`);
  } else {
    res.set('Content-Range', `*/*`);
  }
  if (wantsSingle(req)) {
    if (rows.length !== 1) {
      return res.status(406).json({
        message: `JSON object requested, multiple (or no) rows returned`,
        code: 'PGRST116',
        details: `Results contain ${rows.length} rows`,
        hint: null,
      });
    }
    return res.status(status).json(rows[0]);
  }
  return res.status(status).json(rows);
}

async function loadEmbeds(ctx, rows, embeds, parentTable) {
  for (const embed of embeds) {
    const childPolicy = policyFor(embed.table);
    if (!childPolicy || childPolicy.scope === 'denied') continue;
    const { columns } = parseSelect(embed.select);
    // Detect the join direction from information_schema-free conventions:
    // child.<parent>_id → parent.id, otherwise parent.<child>_id → child.id
    const fkOnChild = `${parentTable.replace(/s$/, '')}_id`;
    const fkOnParent = `${embed.table.replace(/s$/, '')}_id`;
    const parentIds = [...new Set(rows.map((r) => r.id).filter(Boolean))];
    const parentFkValues = [...new Set(rows.map((r) => r[fkOnParent]).filter(Boolean))];

    if (parentFkValues.length) {
      const child = await ctx.q(
        `SELECT ${columns === '*' ? '*' : `${columns}, "id"`} FROM public.${embed.table} WHERE "id" = ANY($1::uuid[])`,
        [parentFkValues],
      );
      const byId = new Map(child.map((c) => [c.id, c]));
      for (const r of rows) r[embed.alias] = byId.get(r[fkOnParent]) ?? null;
    } else if (parentIds.length) {
      const child = await ctx.q(
        `SELECT ${columns === '*' ? '*' : `${columns}, "${fkOnChild}"`} FROM public.${embed.table} WHERE "${fkOnChild}" = ANY($1::uuid[])`,
        [parentIds],
      );
      const grouped = new Map();
      for (const c of child) {
        if (!grouped.has(c[fkOnChild])) grouped.set(c[fkOnChild], []);
        grouped.get(c[fkOnChild]).push(c);
      }
      for (const r of rows) r[embed.alias] = grouped.get(r.id) ?? [];
    }
  }
  return rows;
}

/**
 * Resolve the access rule for a table. When auto-schema is on, a table that is
 * declared in db/schema.sql (or, for writes by a signed-in caller, one that only
 * exists in the payload) is created on the spot and gets an inferred rule.
 */
async function tableOr404(table, { ctx = null, row = null, create = false } = {}) {
  let policy = policyFor(table);
  if (policy) return policy;

  if (autoSchemaEnabled()) {
    const declared = expectedSchema().has(`public.${table}`);
    // Undeclared tables may only be created by the service role — a normal
    // session must never be able to invent tables.
    const mayCreate = declared || (create && ctx?.isServiceRole);
    if (mayCreate) {
      await ensureTable(table, row || {});
      policy = policyFor(table);
      if (policy) return policy;
    }
  }

  throw notFound(`relation "public.${table}" does not exist`, { code: '42P01' });
}

// ── GET /rest/v1/:table ───────────────────────────────────────────────
restRouter.get(
  '/:table',
  asyncHandler(async (req, res) => {
    const { table } = req.params;
    const policy = await tableOr404(table, { ctx: req.ctx });
    const ctx = req.ctx;
    const scope = await scopeFilter(ctx, table, policy, 'read', req.query);

    const { columns, embeds } = parseSelect(req.query.select);
    const params = [...scope.params];
    const built = buildQuery(req.query, { params, extraWhere: scope.where });

    const range = parseRange(req.headers.range);
    const limit = built.limit ?? range?.limit ?? null;
    const offset = built.offset || range?.offset || 0;

    const prefs = preferences(req);
    let total = null;
    if (prefs.count || req.headers.range) {
      const countRow = await ctx.one(`SELECT count(*)::bigint AS c FROM public.${ident(table)}${built.where}`, params);
      total = Number(countRow?.c ?? 0);
    }

    const selectCols = columns === '*' ? '*' : `${columns}, "id"`;
    let sql = `SELECT ${embeds.length ? selectCols : columns} FROM public.${ident(table)}${built.where}${built.orderBy}`;
    if (limit !== null) { params.push(limit); sql += ` LIMIT $${params.length}`; }
    if (offset) { params.push(offset); sql += ` OFFSET $${params.length}`; }

    let rows = await withSelfHeal(table, null, () => ctx.q(sql, params));
    if (embeds.length) rows = await loadEmbeds(ctx, rows, embeds, table);
    rows = stripHidden(rows, policy, ctx);

    return respond(req, res, rows, { total, offset });
  }),
);

// ── POST /rest/v1/:table (insert / upsert) ────────────────────────────
restRouter.post(
  '/:table',
  asyncHandler(async (req, res) => {
    const { table } = req.params;
    const body = req.body;
    const rowsIn = Array.isArray(body) ? body : [body];
    if (!rowsIn.length) throw badRequest('empty insert payload');
    const policy = await tableOr404(table, { ctx: req.ctx, row: rowsIn[0], create: true });
    const ctx = req.ctx;

    // Authorize each row against its own store / user.
    for (const row of rowsIn) await authorizeWrite(ctx, table, policy, row, 'insert');

    // Any attribute in the payload that has no column yet gets one.
    await ensureShape(table, rowsIn);

    const prefs = preferences(req);
    const cols = [...new Set(rowsIn.flatMap((r) => Object.keys(r)))];
    if (!cols.length) throw badRequest('empty insert payload');

    const params = [];
    const valueSql = rowsIn
      .map((row) => `(${cols.map((c) => { params.push(row[c] ?? null); return `$${params.length}`; }).join(', ')})`)
      .join(', ');

    let sql = `INSERT INTO public.${ident(table)} (${cols.map(ident).join(', ')}) VALUES ${valueSql}`;
    const onConflict = req.query.on_conflict;
    if (prefs.resolution === 'merge' && onConflict) {
      const target = String(onConflict).split(',').map(ident).join(', ');
      const updates = cols.filter((c) => !String(onConflict).split(',').includes(c));
      sql += ` ON CONFLICT (${target}) DO UPDATE SET ${updates.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`;
    } else if (prefs.resolution === 'ignore' && onConflict) {
      sql += ` ON CONFLICT (${String(onConflict).split(',').map(ident).join(', ')}) DO NOTHING`;
    }
    sql += ' RETURNING *';

    let rows;
    try {
      rows = await withSelfHeal(table, rowsIn, () => ctx.q(sql, params));
    } catch (e) {
      // 42P10: the on_conflict columns have no unique index. PostgREST fails
      // too, but the frontend depends on these upserts, so match-then-write
      // gives them the same outcome instead of an error.
      if (e?.code !== '42P10' || !onConflict) throw e;
      rows = await emulateUpsert(ctx, table, rowsIn, String(onConflict).split(','), prefs.resolution);
    }

    const inserted = stripHidden(rows, policy, ctx);
    if (!prefs.representation) return res.status(201).set('Content-Range', '*/*').send('');
    return respond(req, res, inserted, { status: 201 });
  }),
);


/**
 * ON CONFLICT without a unique index: find the matching row by the conflict
 * columns, then UPDATE it (merge) or leave it alone (ignore); insert when absent.
 */
async function emulateUpsert(ctx, table, rowsIn, conflictCols, resolution) {
  const out = [];
  for (const row of rowsIn) {
    const keys = conflictCols.map((c) => c.trim()).filter((c) => c in row);
    let existing = null;
    if (keys.length) {
      const params = keys.map((c) => row[c]);
      const where = keys.map((c, i) => `${ident(c)} = $${i + 1}`).join(' AND ');
      const found = await ctx.q(`SELECT * FROM public.${ident(table)} WHERE ${where} LIMIT 1`, params);
      existing = found[0] || null;
    }
    if (existing && resolution === 'ignore') { out.push(existing); continue; }
    if (existing) {
      const setCols = Object.keys(row).filter((c) => !keys.includes(c));
      if (!setCols.length) { out.push(existing); continue; }
      const params = setCols.map((c) => row[c]);
      const sets = setCols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
      const keyParams = keys.map((c) => row[c]);
      const where = keys.map((c, i) => `${ident(c)} = $${setCols.length + i + 1}`).join(' AND ');
      const updated = await ctx.q(
        `UPDATE public.${ident(table)} SET ${sets} WHERE ${where} RETURNING *`,
        [...params, ...keyParams],
      );
      out.push(...updated);
      continue;
    }
    const cols = Object.keys(row);
    const inserted = await ctx.q(
      `INSERT INTO public.${ident(table)} (${cols.map(ident).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      cols.map((c) => row[c] ?? null),
    );
    out.push(...inserted);
  }
  return out;
}

// ── PATCH /rest/v1/:table ─────────────────────────────────────────────
restRouter.patch(
  '/:table',
  asyncHandler(async (req, res) => {
    const { table } = req.params;
    const policy = await tableOr404(table, { ctx: req.ctx, row: req.body });
    const ctx = req.ctx;
    const patch = req.body || {};
    const cols = Object.keys(patch);
    if (!cols.length) throw badRequest('empty update payload');
    if (!hasFilter(req.query)) throw badRequest('UPDATE requires a WHERE clause', { code: 'PGRST109' });

    await authorizeWrite(ctx, table, policy, patch, 'update', req.query);
    const scope = await scopeFilter(ctx, table, policy, 'update', req.query);
    await ensureColumns(table, patch);

    const params = [...scope.params];
    const sets = cols.map((c) => { params.push(patch[c]); return `${ident(c)} = $${params.length}`; });
    const built = buildQuery(req.query, { params, extraWhere: scope.where });
    const sql = `UPDATE public.${ident(table)} SET ${sets.join(', ')}${built.where} RETURNING *`;

    const updated = stripHidden(await withSelfHeal(table, patch, () => ctx.q(sql, params)), policy, ctx);
    const prefs = preferences(req);
    if (!prefs.representation) return res.status(204).set('Content-Range', '*/*').send('');
    return respond(req, res, updated, { status: 200 });
  }),
);

// ── DELETE /rest/v1/:table ────────────────────────────────────────────
restRouter.delete(
  '/:table',
  asyncHandler(async (req, res) => {
    const { table } = req.params;
    const policy = await tableOr404(table, { ctx: req.ctx });
    const ctx = req.ctx;
    if (!hasFilter(req.query)) throw badRequest('DELETE requires a WHERE clause', { code: 'PGRST109' });

    const scope = await scopeFilter(ctx, table, policy, 'delete', req.query);
    const params = [...scope.params];
    const built = buildQuery(req.query, { params, extraWhere: scope.where });
    const sql = `DELETE FROM public.${ident(table)}${built.where} RETURNING *`;
    const deleted = stripHidden(await ctx.q(sql, params), policy, ctx);

    const prefs = preferences(req);
    if (!prefs.representation) return res.status(204).set('Content-Range', '*/*').send('');
    return respond(req, res, deleted, { status: 200 });
  }),
);

function hasFilter(query) {
  return Object.keys(query).some((k) => !['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k));
}

/** Extra guard for writes: the payload's store/user must belong to the caller. */
async function authorizeWrite(ctx, table, policy, row, op, query = {}) {
  if (ctx.isServiceRole) return;
  if (policy.scope === 'denied') throw forbidden(`table "${table}" is not writable over the data API`);
  if (await ctx.isSuperAdmin()) return;

  if (policy.scope === 'store') {
    const col = policy.storeColumn;
    const storeId = row?.[col] || requestedStoreId(query, col);

    // Self-owned row creation (a user creating their own store). The caller is
    // not a member of a store that does not exist yet, so ownership — not
    // membership — is what authorizes the insert, even when the client supplies
    // the primary key itself (supabase-js .insert({ id, user_id })).
    if (op === 'insert' && policy.ownerColumn) {
      if (!ctx.userId) throw forbidden('JWT required');
      const owner = row?.[policy.ownerColumn];
      if (owner && owner !== ctx.userId) throw forbidden('cannot create rows owned by another user');
      if (row) row[policy.ownerColumn] = ctx.userId;
      return;
    }

    if (op === 'insert' && !storeId && col) {
      if (!policy.publicInsert) throw badRequest(`${col} is required`);
      return;
    }
    if (storeId) {
      if (!ctx.userId && policy.publicInsert) return;
      await ctx.assertStoreAccess(storeId, policy.writeRoles || null);
    }
    return;
  }
  if (policy.scope === 'user' || policy.scope === 'profile') {
    if (!ctx.userId) throw forbidden('JWT required');
    const col = policy.scope === 'profile' ? 'id' : policy.userColumn;
    if (row?.[col] && row[col] !== ctx.userId) throw forbidden('cannot write rows owned by another user');
    return;
  }
  if (policy.scope === 'admin' || policy.scope === 'catalog') {
    if (!(await ctx.isAnyAdmin())) throw forbidden('admin role required');
  }
}

export { scopeFilter, respond, preferences, wantsSingle };
