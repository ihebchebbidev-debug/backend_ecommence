// Shop builder — section-based page configs with draft / publish / versions.
import { validateConfig } from '../lib/sections/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const DESIGN_ROLES = ['owner', 'admin', 'manager'];
const KEEP_VERSIONS = 20;

async function row(db, storeId, status, lock = false) {
  return db.one(
    `SELECT configuration, updated_at, published_at FROM public.store_builder_configs WHERE store_id = $1 AND status = $2`,
    [storeId, status],
  );
}

async function upsert(db, storeId, status, config, userId) {
  return db.one(
    `INSERT INTO public.store_builder_configs (store_id, status, configuration, updated_at, updated_by, published_at)
     VALUES ($1, $2, $3::jsonb, now(), $4, CASE WHEN $2 = 'published' THEN now() END)
     ON CONFLICT (store_id, status) DO UPDATE
       SET configuration = EXCLUDED.configuration, updated_at = now(), updated_by = EXCLUDED.updated_by,
           published_at = COALESCE(EXCLUDED.published_at, public.store_builder_configs.published_at)
     RETURNING configuration, updated_at, published_at`,
    [storeId, status, JSON.stringify(config), userId],
  );
}

export default {
  /** Anonymous visitors can send a form only when that exact section is currently published. */
  async builder_submit_form({ p_store_id, p_section_id, p_name, p_email, p_message }, ctx) {
    const store = await ctx.one('SELECT id FROM public.platform_stores WHERE id = $1 AND deleted_at IS NULL AND status = $2', [p_store_id, 'active']);
    if (!store) throw notFound('Boutique introuvable');
    const pub = await row(ctx, p_store_id, 'published');
    const section = Object.values(pub?.configuration?.pages || {}).flatMap(page => page.sections || [])
      .find(s => s.id === p_section_id && (s.type === 'contact_form' || s.type === 'newsletter') && !s.hidden);
    if (!section) throw badRequest('Formulaire non publié');
    const name = String(p_name || '').trim(), email = String(p_email || '').trim().toLowerCase(), message = String(p_message || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || name.length > 100 || message.length > 2000) throw badRequest('Champs invalides');
    if (section.type === 'contact_form' && (!name || !message)) throw badRequest('Nom et message requis');
    const rate = await ctx.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE email = $2)::int AS per_email
      FROM public.store_form_submissions WHERE store_id = $1 AND created_at > now() - interval '1 hour'`, [p_store_id, email]);
    if (rate.total >= 300 || rate.per_email >= 5) throw badRequest('Trop de messages. Réessayez dans une heure.');
    await ctx.q('INSERT INTO public.store_form_submissions (store_id, section_id, form_title, name, email, message) VALUES ($1,$2,$3,$4,$5,$6)',
      [p_store_id, p_section_id, String(section.settings?.title || 'Formulaire').slice(0, 100), name || null, email, message || null]);
    return { success: true };
  },

  async builder_list_submissions({ p_store_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    if (!(await ctx.canViewCustomerData(p_store_id))) throw badRequest('Accès aux données clients indisponible');
    return ctx.q('SELECT id, section_id, form_title, name, email, message, created_at FROM public.store_form_submissions WHERE store_id = $1 ORDER BY created_at DESC LIMIT 200', [p_store_id]);
  },
  /** builder_get_draft(p_store_id) → { configuration, updated_at, published_at, has_published } */
  async builder_get_draft({ p_store_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    const published = await row(ctx, p_store_id, 'published');
    let draft = await row(ctx, p_store_id, 'draft');
    if (!draft && published) draft = await upsert(ctx, p_store_id, 'draft', published.configuration, ctx.userId);
    return {
      configuration: draft?.configuration ?? null,
      updated_at: draft?.updated_at ?? null,
      published_at: published?.published_at ?? null,
      has_published: !!published,
    };
  },

  /** builder_save_draft(p_store_id, p_config, p_expected_updated_at) → { updated_at } */
  async builder_save_draft({ p_store_id, p_config, p_expected_updated_at }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    const config = validateConfig(p_config);
    return ctx.tx(async (t) => {
      const current = await t.one(
        `SELECT updated_at FROM public.store_builder_configs WHERE store_id = $1 AND status = 'draft' FOR UPDATE`,
        [p_store_id],
      );
      const expectedProvided = p_expected_updated_at !== undefined;
      const expectedTime = p_expected_updated_at == null ? null : new Date(p_expected_updated_at).getTime();
      if (expectedProvided && current && (expectedTime === null || !Number.isFinite(expectedTime) || new Date(current.updated_at).getTime() !== expectedTime)) {
        throw conflict('Ce brouillon a été modifié ailleurs. Rechargez pour voir la dernière version.');
      }
      if (expectedProvided && !current && expectedTime !== null) {
        throw conflict('Ce brouillon a été supprimé ou remplacé. Rechargez avant de continuer.');
      }
      const saved = await upsert(t, p_store_id, 'draft', config, ctx.userId);
      return { updated_at: saved.updated_at };
    });
  },

  /** builder_publish(p_store_id, p_label?) → { published_at } */
  async builder_publish({ p_store_id, p_label }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    return ctx.tx(async (t) => {
      const draft = await t.one(
        `SELECT configuration FROM public.store_builder_configs WHERE store_id = $1 AND status = 'draft' FOR UPDATE`,
        [p_store_id],
      );
      if (!draft) throw notFound('Aucun brouillon à publier');
      const config = validateConfig(draft.configuration);
      const pub = await upsert(t, p_store_id, 'published', config, ctx.userId);
      await t.q(
        `INSERT INTO public.store_theme_versions (store_id, configuration, label, published_by, published_at) VALUES ($1, $2::jsonb, $3, $4, clock_timestamp())`,
        [p_store_id, JSON.stringify(config), p_label ? String(p_label).slice(0, 80) : null, ctx.userId],
      );
      await t.q(
        `DELETE FROM public.store_theme_versions WHERE store_id = $1 AND id NOT IN (
           SELECT id FROM public.store_theme_versions WHERE store_id = $1 ORDER BY published_at DESC, id DESC LIMIT ${KEEP_VERSIONS})`,
        [p_store_id],
      );
      return { published_at: pub.published_at };
    });
  },

  /** builder_list_versions(p_store_id) → { id, label, published_at }[] */
  async builder_list_versions({ p_store_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    return ctx.q(
      `SELECT id, label, published_at, configuration->>'template' AS template
         FROM public.store_theme_versions WHERE store_id = $1 ORDER BY published_at DESC, id DESC LIMIT ${KEEP_VERSIONS}`,
      [p_store_id],
    );
  },

  /** builder_restore_version(p_store_id, p_version_id) → { updated_at } (into draft) */
  async builder_restore_version({ p_store_id, p_version_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    return ctx.tx(async (t) => {
      const v = await t.one(
        `SELECT configuration FROM public.store_theme_versions WHERE id = $1 AND store_id = $2`,
        [p_version_id, p_store_id],
      );
      if (!v) throw notFound('Version introuvable');
      const config = validateConfig(v.configuration);
      const saved = await upsert(t, p_store_id, 'draft', config, ctx.userId);
      return { updated_at: saved.updated_at, configuration: saved.configuration };
    });
  },

  /** get_store_page_config(p_store_id) → published configuration | null (public) */
  async get_store_page_config({ p_store_id }, ctx) {
    const store = await ctx.one(
      `SELECT id FROM public.platform_stores WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
      [p_store_id],
    );
    if (!store) return null;
    const pub = await row(ctx, p_store_id, 'published');
    return pub?.configuration ?? null;
  },
};
