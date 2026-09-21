// PostgREST-compatible query string → SQL.
// Supports: select, eq, neq, gt, gte, lt, lte, like, ilike, is, in, cs, cd,
// not.*, or=(...), and=(...), order, limit, offset, range via headers.
import { badRequest } from '../lib/errors.js';

const OPS = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'ILIKE', match: '~', imatch: '~*',
};

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

const ident = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw badRequest(`invalid identifier "${name}"`);
  return `"${name}"`;
};

/** `select=a,b,c` → column list. Embedded resources are handled in router.js. */
export function parseSelect(select) {
  if (!select || select.trim() === '*') return { columns: '*', embeds: [] };
  const parts = splitTop(select, ',');
  const cols = [];
  const embeds = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    // `select=*,child(*)` — a bare star alongside embeds stays a star.
    if (part === '*') { cols.push('*'); continue; }
    const embedMatch = part.match(/^([A-Za-z0-9_]+)(?::([A-Za-z0-9_]+))?\s*\(([\s\S]*)\)$/);
    if (embedMatch) {
      embeds.push({ alias: embedMatch[1], table: embedMatch[2] || embedMatch[1], select: embedMatch[3] });
      continue;
    }
    const [lhs, rhs] = part.includes(':') ? [part.split(':')[1], part.split(':')[0]] : [part, null];
    cols.push(rhs ? `${ident(lhs)} AS ${ident(rhs)}` : ident(lhs));
  }
  return { columns: cols.length ? cols.join(', ') : '*', embeds };
}

/** Split on a separator, ignoring separators inside parentheses / quotes. */
function splitTop(input, sep) {
  const out = [];
  let depth = 0, cur = '', quoted = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseValue(op, raw) {
  if (op === 'is') {
    const v = raw.toLowerCase();
    if (v === 'null') return null;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return raw;
  }
  if (op === 'in') {
    const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
    if (inner === '') return [];
    return splitTop(inner, ',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
  }
  if (op === 'cs' || op === 'cd') return raw;
  return raw;
}

/** Build one `column.op.value` condition. Returns { sql, params }. */
function buildCondition(column, spec, params) {
  let rest = spec;
  let negate = false;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  const op = dot === -1 ? 'eq' : rest.slice(0, dot);
  const raw = dot === -1 ? rest : rest.slice(dot + 1);
  const value = parseValue(op, raw);
  const col = ident(column);
  let sql;

  if (op === 'is') {
    sql = value === null ? `${col} IS NULL` : `${col} IS ${value ? 'TRUE' : 'FALSE'}`;
  } else if (op === 'in') {
    if (value.length === 0) sql = 'FALSE';
    else { params.push(value); sql = `${col}::text = ANY($${params.length}::text[])`; }
  } else if (op === 'cs') {
    params.push(raw.startsWith('{') ? raw : JSON.parse(raw));
    sql = `${col} @> $${params.length}`;
  } else if (op === 'cd') {
    params.push(raw.startsWith('{') ? raw : JSON.parse(raw));
    sql = `${col} <@ $${params.length}`;
  } else if (op === 'fts' || op === 'plfts') {
    params.push(value);
    sql = `to_tsvector(${col}::text) @@ plainto_tsquery($${params.length})`;
  } else if (OPS[op]) {
    // PostgREST spells the LIKE wildcard `*` (a literal % would need escaping
    // in a URL), so `name=like.A*` must become `name LIKE 'A%'`.
    params.push(op === 'like' || op === 'ilike' ? String(value).replace(/\*/g, '%') : value);
    sql = `${col}::text ${OPS[op]} $${params.length}`;
  } else {
    throw badRequest(`unknown operator "${op}"`);
  }
  return negate ? `NOT (${sql})` : sql;
}

/** Parse `or=(a.eq.1,b.is.null)` / `and=(...)`. */
function buildLogical(kind, spec, params) {
  const inner = spec.replace(/^\(/, '').replace(/\)$/, '');
  const parts = splitTop(inner, ',').map((p) => p.trim()).filter(Boolean);
  const conds = parts.map((p) => {
    if (p.startsWith('or(') || p.startsWith('and(')) {
      const k = p.startsWith('or(') ? 'or' : 'and';
      return `(${buildLogical(k, p.slice(k.length), params)})`;
    }
    const dot = p.indexOf('.');
    return buildCondition(p.slice(0, dot), p.slice(dot + 1), params);
  });
  return conds.join(kind === 'or' ? ' OR ' : ' AND ');
}

/**
 * @returns {{ where: string, params: any[], orderBy: string, limit: number|null, offset: number }}
 */
export function buildQuery(query, { params = [], extraWhere = [] } = {}) {
  const conds = [...extraWhere];

  for (const [key, rawVal] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    const values = Array.isArray(rawVal) ? rawVal : [rawVal];
    for (const val of values) {
      if (key === 'or' || key === 'and') conds.push(`(${buildLogical(key, val, params)})`);
      else conds.push(buildCondition(key, String(val), params));
    }
  }

  let orderBy = '';
  if (query.order) {
    const clauses = String(query.order)
      .split(',')
      .map((part) => {
        const [col, ...mods] = part.trim().split('.');
        const dir = mods.includes('desc') ? 'DESC' : 'ASC';
        const nulls = mods.includes('nullsfirst') ? ' NULLS FIRST' : mods.includes('nullslast') ? ' NULLS LAST' : '';
        return `${ident(col)} ${dir}${nulls}`;
      });
    orderBy = ` ORDER BY ${clauses.join(', ')}`;
  }

  return {
    where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '',
    params,
    orderBy,
    limit: query.limit != null ? Number(query.limit) : null,
    offset: query.offset != null ? Number(query.offset) : 0,
  };
}

/** `Range: 0-9` header → { limit, offset } */
export function parseRange(header) {
  if (!header) return null;
  const m = String(header).match(/^(\d+)-(\d*)$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === '' ? null : Number(m[2]);
  return { offset: from, limit: to === null ? null : to - from + 1 };
}

export { ident, splitTop };
