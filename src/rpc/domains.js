// Seller domains require routing records and a request-specific ownership proof.
import dns from 'node:dns/promises';
import { badRequest, forbidden } from '../lib/errors.js';
import { checkCertificate, healthChecks } from '../lib/domainHealth.js';

// Seller domains must point at the platform server (same address as e-commence.shop).
export const platformIps = () => String(process.env.PLATFORM_DOMAIN_IPS || '186.241.19.85').split(',').map((s) => s.trim()).filter(Boolean);

/** DNS check: root and www must both resolve only to platform addresses. Pure decision kept testable. */
export function dnsVerdict(rootIps, wwwIps, allowed) {
  const ok = (ips) => ips.length > 0 && ips.every((ip) => allowed.includes(ip));
  return { root: ok(rootIps), www: ok(wwwIps), ok: ok(rootIps) && ok(wwwIps) };
}
export const ownershipRecord = (id) => `e-commence-verify=${id}`;
export async function checkDomainDns(domain, id) {
  const resolver = new dns.Resolver({ timeout: 2000, tries: 2 });
  const addresses = async (host) => (await Promise.all([
    resolver.resolve4(host).catch(() => []), resolver.resolve6(host).catch(() => []),
  ])).flat();
  const [root, www, txt] = await Promise.all([
    addresses(domain), addresses(`www.${domain}`), resolver.resolveTxt(`_e-commence.${domain}`).catch(() => []),
  ]);
  const verdict = dnsVerdict(root, www, platformIps());
  const ownership = txt.some((chunks) => chunks.join('') === ownershipRecord(id));
  return { ...verdict, ok: verdict.ok && ownership, ownership, found: { root, www, txt: txt.map((chunks) => chunks.join('')).sort() }, expected: platformIps(), expected_proof: ownershipRecord(id) };
}

/** Activates the request and links it to the shop; retires the shop's previous active domain. */
async function activate(t, storeId, id, domain) {
  await t.q(`UPDATE public.store_domain_requests SET status = 'active', updated_at = now() WHERE id = $1`, [id]);
  // A domain serves exactly one shop: clear any stale link on another shop before linking this one.
  await t.q('UPDATE public.platform_stores SET store_domain = NULL WHERE id <> $1 AND lower(store_domain) = lower($2)', [storeId, domain]);
  await t.q('UPDATE public.platform_stores SET store_domain = $2 WHERE id = $1', [storeId, domain]);
  await t.q(
    `UPDATE public.store_domain_requests SET status = 'cancelled', admin_note = coalesce(admin_note, 'Remplacé par ' || $3), updated_at = now()
      WHERE store_id = $1 AND status = 'active' AND id <> $2`, [storeId, id, domain]);
}

const OWNER_ROLES = ['owner', 'admin'];
const STATUSES = ['pending', 'in_progress', 'active', 'rejected', 'cancelled'];
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function validSellerDomain(domain) {
  const reserved = ['e-commence.shop', 'lovable.app', 'lovableproject.com', 'lovable.dev', 'vercel.app',
    ...String(process.env.PLATFORM_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return DOMAIN_RE.test(domain) && !reserved.some((host) => domain === host || domain.endsWith(`.${host}`));
}
async function lockStore(t, storeId) {
  if (!await t.one('SELECT id FROM public.platform_stores WHERE id = $1 FOR UPDATE', [storeId])) throw badRequest('Boutique introuvable');
}
async function auditActor(t, ctx) {
  await t.q("SELECT set_config('app.domain_actor', $1, true)", [ctx.userId || '']);
}
async function auditVerification(t, ctx, req, storeId, result) {
  const shop = await t.one('SELECT store_name, slug FROM public.platform_stores WHERE id = $1', [storeId]);
  const previous = await t.one(`SELECT details FROM public.admin_audit_logs
    WHERE action = 'domain_verification' AND target_store_id = $1 AND details->>'request_id' = $2
    ORDER BY created_at DESC, id DESC LIMIT 1`, [storeId, req.id]);
  const details = { request_id: req.id, domain: req.domain, store_name: shop?.store_name, slug: shop?.slug, ...result };
  const old = previous?.details;
  const changed = !old || JSON.stringify(old.found?.txt || []) !== JSON.stringify(result.found.txt) || old.ownership !== result.ownership || old.expected_proof !== result.expected_proof;
  if (changed) await t.q(`INSERT INTO public.admin_audit_logs(action, performed_by, target_store_id, details) VALUES ($1,$2,$3,$4)`,
    ['domain_ownership_proof_changed', ctx.userId, storeId, { request_id: req.id, domain: req.domain,
      before: old ? { txt: old.found?.txt, matches: old.ownership, expected: old.expected_proof } : null,
      after: { txt: result.found.txt, matches: result.ownership, expected: result.expected_proof } }]);
  await t.q(`INSERT INTO public.admin_audit_logs(action, performed_by, target_store_id, details) VALUES ($1,$2,$3,$4)`,
    ['domain_verification', ctx.userId, storeId, details]);
}

export const normalizeDomain = (v) => String(v || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

async function requireSuperAdmin(ctx) {
  ctx.requireAuth();
  if (!(await ctx.isSuperAdmin())) throw forbidden('Super admin access required');
}

/** Two shops racing for one domain hit the open-domain unique index: report it plainly. */
export async function claimOnce(work) {
  try { return await work(); } catch (e) {
    if (e?.code === '23505') throw badRequest('Ce domaine est déjà relié à une autre boutique');
    throw e;
  }
}

const COLS = 'id, store_id, domain, availability, already_owned, contact_email, contact_phone, business_name, notes, status, admin_note, created_at, updated_at';

const domainRpc = {
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
    if (!validSellerDomain(domain)) throw badRequest('Nom de domaine invalide');
    const email = String(p_contact_email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('E-mail de contact invalide');
    return ctx.tx(async (t) => {
    await lockStore(t, p_store_id);
    await auditActor(t, ctx);
    const open = await t.q(`SELECT id FROM public.store_domain_requests WHERE store_id = $1 AND status IN ('pending','in_progress')`, [p_store_id]);
    if (open.length) throw badRequest('Une demande est déjà en cours pour cette boutique');
    const taken = await t.q(`SELECT id FROM public.store_domain_requests WHERE lower(domain) = $1 AND status IN ('pending','in_progress','active')`, [domain]);
    if (taken.length) throw badRequest('Ce domaine est déjà demandé');
    const availability = ['available', 'taken'].includes(p_availability) ? p_availability : 'unknown';
    const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
    const rows = await t.q(
      `INSERT INTO public.store_domain_requests (store_id, requested_by, domain, availability, already_owned, contact_email, contact_phone, business_name, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [p_store_id, ctx.userId, domain, availability, !!p_already_owned, email.slice(0, 200), clip(p_contact_phone, 40), clip(p_business_name, 120), clip(p_notes, 1000)],
    );
    return rows[0];
    });
  },

  /** domain_connect(p_store_id, p_domain) — seller links a domain they already bought anywhere. */
  async domain_connect({ p_store_id, p_domain }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    const domain = normalizeDomain(p_domain);
    if (!validSellerDomain(domain)) throw badRequest('Nom de domaine invalide');
    const email = (await ctx.profile())?.email || 'unknown@e-commence.shop';
    return claimOnce(() => ctx.tx(async (t) => {
    await lockStore(t, p_store_id);
    await auditActor(t, ctx);
    const taken = await t.q(`SELECT store_id FROM public.store_domain_requests WHERE lower(domain) = $1 AND status IN ('pending','in_progress','active')`, [domain]);
    if (taken.some((r) => r.store_id !== p_store_id)) throw badRequest('Ce domaine est déjà relié à une autre boutique');
    if (taken.length) return null;
    // Withdraw any other unfinished connection of this shop: one domain in progress at a time.
    await t.q(`UPDATE public.store_domain_requests SET status = 'cancelled', updated_at = now() WHERE store_id = $1 AND status IN ('pending','in_progress')`, [p_store_id]);
    await t.q(
      `INSERT INTO public.store_domain_requests (store_id, requested_by, domain, availability, already_owned, contact_email, status)
       VALUES ($1,$2,$3,'taken',true,$4,'pending')`, [p_store_id, ctx.userId, domain, String(email).slice(0, 200)]);
    return null;
    }));
  },

  /** domain_verify(p_store_id, p_id) → { ok, root, www } — checks DNS and activates the domain when it points here. */
  async domain_verify({ p_store_id, p_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    const req = await ctx.one(`SELECT id, domain, status FROM public.store_domain_requests WHERE id = $1 AND store_id = $2`, [p_id, p_store_id]);
    if (!req || !['pending', 'in_progress', 'active'].includes(req.status)) throw badRequest('Domaine introuvable');
    const v = await checkDomainDns(req.domain, req.id);
    await ctx.tx(async (t) => {
      await lockStore(t, p_store_id);
      const current = await t.one('SELECT status FROM public.store_domain_requests WHERE id = $1 AND store_id = $2 FOR UPDATE', [p_id, p_store_id]);
      if (!current || !['pending', 'in_progress', 'active'].includes(current.status)) throw badRequest('Cette connexion a été annulée.');
      await auditActor(t, ctx);
      await auditVerification(t, ctx, req, p_store_id, v);
      if (v.ok && current.status !== 'active') await activate(t, p_store_id, req.id, req.domain);
    });
    return v;
  },

  async domain_health({ p_store_id, p_id }, ctx) {
    // Reuse the permission check, locked audit and safe automatic activation.
    const v = await domainRpc.domain_verify({ p_store_id, p_id }, ctx);
    const req = await ctx.one('SELECT domain, status FROM public.store_domain_requests WHERE id = $1 AND store_id = $2', [p_id, p_store_id]);
    if (!req) throw badRequest('Domain connection no longer exists.');
    const shop = await ctx.one('SELECT store_name, store_domain FROM public.platform_stores WHERE id = $1', [p_store_id]);
    const linked = req.status === 'active' && shop?.store_domain === req.domain;
    const notChecked = { ready: false, reason: 'dns_not_ready' };
    const probe = async (host, ips) => {
      const results = await Promise.all(ips.map((ip) => checkCertificate(host, ip)));
      return results.find((r) => !r.ready) || results[0] || notChecked;
    };
    const [root, www] = v.ok && linked ? await Promise.all([
      probe(req.domain, v.found.root), probe(`www.${req.domain}`, v.found.www),
    ]) : [notChecked, notChecked];
    const checks = healthChecks(req.domain, v, { root, www }, linked);
    return { ...v, ok: checks.every((c) => c.ready), dns_ok: v.ok, linked, shop_name: shop?.store_name,
      checked_at: new Date().toISOString(), https: { root, www }, checks, next_fix: checks.find((c) => !c.ready)?.fix || null };
  },

  async admin_domain_audit_list({ p_domain = '', p_store_id = null, p_before = null } = {}, ctx) {
    await requireSuperAdmin(ctx);
    const domain = String(p_domain).trim().toLowerCase().slice(0, 253);
    const rows = await ctx.q(`SELECT a.id, a.action, a.created_at, a.performed_by, a.target_store_id,
      a.details, s.store_name, s.slug FROM public.admin_audit_logs a
      LEFT JOIN public.platform_stores s ON s.id = a.target_store_id
      WHERE a.action LIKE 'domain_%' AND ($1 = '' OR position($1 in lower(coalesce(a.details->>'domain',''))) > 0)
      AND ($2::uuid IS NULL OR a.target_store_id = $2::uuid)
      AND ($3::uuid IS NULL OR (a.created_at, a.id) < (SELECT created_at, id FROM public.admin_audit_logs WHERE id = $3::uuid))
      ORDER BY a.created_at DESC, a.id DESC LIMIT 101`, [domain, p_store_id, p_before]);
    return { events: rows.slice(0, 100), next_cursor: rows.length > 100 ? rows[99].id : null };
  },

  /** domain_request_cancel(p_store_id, p_id) — seller withdraws a pending request */
  async domain_request_cancel({ p_store_id, p_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, OWNER_ROLES);
    return ctx.tx(async (t) => {
    await lockStore(t, p_store_id);
    await auditActor(t, ctx);
    const rows = await t.q(
      `UPDATE public.store_domain_requests SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND store_id = $2 AND status IN ('pending','in_progress','active') RETURNING domain`, [p_id, p_store_id]);
    if (rows.length) await t.q('UPDATE public.platform_stores SET store_domain = NULL WHERE id = $1 AND lower(store_domain) = lower($2)', [p_store_id, rows[0].domain]);
    if (!rows.length) throw badRequest('Cette demande ne peut plus être annulée');
    return null;
    });
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
    const req = await ctx.one('SELECT store_id, domain FROM public.store_domain_requests WHERE id = $1', [p_id]);
    if (!req) throw badRequest('Demande introuvable');
    if (p_status === 'active') {
      const v = await checkDomainDns(req.domain, p_id);
      await ctx.tx(async (t) => {
        await lockStore(t, req.store_id);
        await auditVerification(t, ctx, { ...req, id: p_id }, req.store_id, v);
      });
      if (!validSellerDomain(req.domain) || !v.ok) throw badRequest('Vérifiez les enregistrements A, www et TXT de propriété avant l’activation.');
    }
    return ctx.tx(async (t) => {
      await lockStore(t, req.store_id);
      await auditActor(t, ctx);
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
export default domainRpc;
