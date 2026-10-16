// Custom domain requests: sellers submit, the platform owner connects the domain by hand and marks it active.
import dns from 'node:dns/promises';
import { badRequest, forbidden } from '../lib/errors.js';

// Seller domains must point at the platform server (same address as e-commence.shop).
export const platformIps = () => String(process.env.PLATFORM_DOMAIN_IPS || '186.241.19.85').split(',').map((s) => s.trim()).filter(Boolean);

/** DNS check: root and www must both resolve only to platform addresses. Pure decision kept testable. */
export function dnsVerdict(rootIps, wwwIps, allowed) {
  const ok = (ips) => ips.length > 0 && ips.every((ip) => allowed.includes(ip));
  return { root: ok(rootIps), www: ok(wwwIps), ok: ok(rootIps) && ok(wwwIps) };
}
const resolve = (host) => dns.resolve4(host).catch(() => []);

/** Activates the request and links it to the shop; retires the shop's previous active domain. */
async function activate(t, storeId, id, domain) {
  await t.q(`UPDATE public.store_domain_requests SET status = 'active', updated_at = now() WHERE id = $1`, [id]);
  await t.q('UPDATE public.platform_stores SET store_domain = $2 WHERE id = $1', [storeId, domain]);
  await t.q(
    `UPDATE public.store_domain_requests SET status = 'cancelled', admin_note = coalesce(admin_note, 'Remplacé par ' || $3), updated_at = now()
      WHERE store_id = $1 AND status = 'active' AND id <> $2`, [storeId, id, domain]);
}

const OWNER_ROLES = ['owner', 'admin'];
const STATUSES = ['pending', 'in_progress', 'active', 'rejected', 'cancelled'];
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const normalizeDomain = (v) => String(v || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

async function requireSuperAdmin(ctx) {
  ctx.requireAuth();
  if (!(await ctx.isSuperAdmin())) throw forbidden('Super admin access required');
}

const COLS = 'id, store_id, domain, availability, already_owned, contact_email, contact_phone, business_name, notes, status, admin_note, created_at, updated_at';

export default {
  /** store_slug_for_domain(p_domain) → slug of the active shop whose activated domain matches, or null. Public. */
  async store_slug_for_domain({ p_domain }, ctx) {
    const domain = normalizeDomain(p_domain);
    if (!DOMAIN_RE.test(domain)) return null;
    const rows = await ctx.q(
      `SELECT s.slug FROM public.platform_stores s
        WHERE lower(s.store_domain) = $1 AND s.deleted_at IS NULL AND s.status = 'active'
          AND EXISTS (SELECT 1 FROM public.store_domain_requests r WHERE r.store_id = s.id AND lower(r.domain) = $1 AND r.status = 'active')
        LIMIT 1`, [domain]);
    return rows[0]?.slug ?? null;
  },

  /** domain_request_list(p_store_id) → requests of the seller's own shop */
  async domain_request_list({ p_store_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    return ctx.q(`SELECT ${COLS} FROM public.store_domain_requests WHERE store_id = $1 ORDER BY created_at DESC LIMIT 50`, [p_store_id]);
  },

  /** domain_request_submit(p_store_id, p_domain, ...) → the new request */
  async domain_request_submit({ p_store_id, p_domain, p_availability, p_already_owned, p_contact_email, p_contact_phone, p_business_name, p_notes }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    const domain = normalizeDomain(p_domain);
    if (!DOMAIN_RE.test(domain)) throw badRequest('Nom de domaine invalide');
    const email = String(p_contact_email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('E-mail de contact invalide');
    const open = await ctx.q(`SELECT id FROM public.store_domain_requests WHERE store_id = $1 AND status IN ('pending','in_progress')`, [p_store_id]);
    if (open.length) throw badRequest('Une demande est déjà en cours pour cette boutique');
    const taken = await ctx.q(`SELECT id FROM public.store_domain_requests WHERE lower(domain) = $1 AND status IN ('pending','in_progress','active')`, [domain]);
    if (taken.length) throw badRequest('Ce domaine est déjà demandé');
    const availability = ['available', 'taken'].includes(p_availability) ? p_availability : 'unknown';
    const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
    const rows = await ctx.q(
      `INSERT INTO public.store_domain_requests (store_id, requested_by, domain, availability, already_owned, contact_email, contact_phone, business_name, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [p_store_id, ctx.userId, domain, availability, !!p_already_owned, email.slice(0, 200), clip(p_contact_phone, 40), clip(p_business_name, 120), clip(p_notes, 1000)],
    );
    return rows[0];
  },

  /** domain_connect(p_store_id, p_domain) — seller links a domain they already bought anywhere. */
  async domain_connect({ p_store_id, p_domain }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    const domain = normalizeDomain(p_domain);
    if (!DOMAIN_RE.test(domain) || domain.endsWith('e-commence.shop')) throw badRequest('Nom de domaine invalide');
    const taken = await ctx.q(`SELECT store_id FROM public.store_domain_requests WHERE lower(domain) = $1 AND status IN ('pending','in_progress','active')`, [domain]);
    if (taken.some((r) => r.store_id !== p_store_id)) throw badRequest('Ce domaine est déjà relié à une autre boutique');
    if (taken.length) return null;
    // Withdraw any other unfinished connection of this shop: one domain in progress at a time.
    await ctx.q(`UPDATE public.store_domain_requests SET status = 'cancelled', updated_at = now() WHERE store_id = $1 AND status IN ('pending','in_progress')`, [p_store_id]);
    const email = (await ctx.profile())?.email || 'unknown@e-commence.shop';
    await ctx.q(
      `INSERT INTO public.store_domain_requests (store_id, requested_by, domain, availability, already_owned, contact_email, status)
       VALUES ($1,$2,$3,'taken',true,$4,'pending')`, [p_store_id, ctx.userId, domain, String(email).slice(0, 200)]);
    return null;
  },

  /** domain_verify(p_store_id, p_id) → { ok, root, www } — checks DNS and activates the domain when it points here. */
  async domain_verify({ p_store_id, p_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    const req = await ctx.one(`SELECT id, domain, status FROM public.store_domain_requests WHERE id = $1 AND store_id = $2`, [p_id, p_store_id]);
    if (!req || !['pending', 'in_progress', 'active'].includes(req.status)) throw badRequest('Domaine introuvable');
    const [rootIps, wwwIps] = await Promise.all([resolve(req.domain), resolve(`www.${req.domain}`)]);
    const v = dnsVerdict(rootIps, wwwIps, platformIps());
    if (v.ok && req.status !== 'active') await ctx.tx((t) => activate(t, p_store_id, req.id, req.domain));
    return { ...v, found: { root: rootIps, www: wwwIps }, expected: platformIps() };
  },

  /** domain_request_cancel(p_store_id, p_id) — seller withdraws a pending request */
  async domain_request_cancel({ p_store_id, p_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    const rows = await ctx.q(
      `UPDATE public.store_domain_requests SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND store_id = $2 AND status IN ('pending','in_progress','active') RETURNING domain`, [p_id, p_store_id]);
    if (rows.length) await ctx.q('UPDATE public.platform_stores SET store_domain = NULL WHERE id = $1 AND lower(store_domain) = lower($2)', [p_store_id, rows[0].domain]);
    if (!rows.length) throw badRequest('Cette demande ne peut plus être annulée');
    return null;
  },

  /** admin_domain_requests_list() → all requests with shop name/slug */
  async admin_domain_requests_list(_args, ctx) {
    await requireSuperAdmin(ctx);
    return ctx.q(
      `SELECT r.id, r.store_id, r.domain, r.availability, r.already_owned, r.contact_email, r.contact_phone, r.business_name, r.notes,
              r.status, r.admin_note, r.created_at, r.updated_at, s.store_name, s.slug
       FROM public.store_domain_requests r JOIN public.platform_stores s ON s.id = r.store_id
       ORDER BY r.created_at DESC LIMIT 500`);
  },

  /** admin_domain_request_update(p_id, p_status, p_admin_note) — marking active also sets the shop's store_domain */
  async admin_domain_request_update({ p_id, p_status, p_admin_note }, ctx) {
    await requireSuperAdmin(ctx);
    if (!STATUSES.includes(p_status)) throw badRequest('Statut invalide');
    return ctx.tx(async (t) => {
      const rows = await t.q(
        `UPDATE public.store_domain_requests SET status = $2, admin_note = $3, updated_at = now() WHERE id = $1 RETURNING store_id, domain`,
        [p_id, p_status, p_admin_note == null ? null : String(p_admin_note).slice(0, 1000)]);
      if (!rows.length) throw badRequest('Demande introuvable');
      const { store_id, domain } = rows[0];
      if (p_status === 'active') await activate(t, store_id, p_id, domain);
      else await t.q('UPDATE public.platform_stores SET store_domain = NULL WHERE id = $1 AND lower(store_domain) = $2', [store_id, domain]);
      await t.q(
        `INSERT INTO public.admin_audit_logs (action, performed_by, target_store_id, details) VALUES ($1,$2,$3,$4)`,
        ['domain_request_update', ctx.userId, store_id, { domain, status: p_status }]);
      return { ok: true };
    });
  },
};
