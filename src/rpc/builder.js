// Shop builder — section-based page configs with draft / publish / versions.
import { validateConfig } from '../lib/sections/index.js';
import { conflict, notFound } from '../lib/errors.js';

const DESIGN_ROLES = ['owner', 'admin', 'manager'];
const KEEP_VERSIONS = 20;

async function row(ctx, storeId, status) {
  return ctx.one(
    `SELECT configuration, updated_at, published_at FROM public.store_builder_configs WHERE store_id = $1 AND status = $2`,
    [storeId, status],
  );
}

async function upsert(ctx, storeId, status, config) {
  return ctx.one(
    `INSERT INTO public.store_builder_configs (store_id, status, configuration, updated_at, updated_by, published_at)
     VALUES ($1, $2, $3::jsonb, now(), $4, CASE WHEN $2 = 'published' THEN now() END)
     ON CONFLICT (store_id, status) DO UPDATE
       SET configuration = EXCLUDED.configuration, updated_at = now(), updated_by = EXCLUDED.updated_by,
           published_at = COALESCE(EXCLUDED.published_at, public.store_builder_configs.published_at)
     RETURNING configuration, updated_at, published_at`,
    [storeId, status, JSON.stringify(config), ctx.userId],
  );
}

export default {
  /** builder_get_draft(p_store_id) → { configuration, updated_at, published_at, has_published } */
  async builder_get_draft({ p_store_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    const published = await row(ctx, p_store_id, 'published');
    let draft = await row(ctx, p_store_id, 'draft');
    if (!draft && published) draft = await upsert(ctx, p_store_id, 'draft', published.configuration);
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
    const current = await row(ctx, p_store_id, 'draft');
    if (current && p_expected_updated_at && new Date(current.updated_at).getTime() !== new Date(p_expected_updated_at).getTime()) {
      throw conflict('Ce brouillon a été modifié ailleurs. Rechargez pour voir la dernière version.');
    }
    const saved = await upsert(ctx, p_store_id, 'draft', config);
    return { updated_at: saved.updated_at };
  },

  /** builder_publish(p_store_id, p_label?) → { published_at } */
  async builder_publish({ p_store_id, p_label }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    const draft = await row(ctx, p_store_id, 'draft');
    if (!draft) throw notFound('Aucun brouillon à publier');
    const config = validateConfig(draft.configuration);
    const pub = await upsert(ctx, p_store_id, 'published', config);
    await ctx.q(
      `INSERT INTO public.store_theme_versions (store_id, configuration, label, published_by) VALUES ($1, $2::jsonb, $3, $4)`,
      [p_store_id, JSON.stringify(config), p_label ? String(p_label).slice(0, 80) : null, ctx.userId],
    );
    await ctx.q(
      `DELETE FROM public.store_theme_versions WHERE store_id = $1 AND id NOT IN (
         SELECT id FROM public.store_theme_versions WHERE store_id = $1 ORDER BY published_at DESC LIMIT ${KEEP_VERSIONS})`,
      [p_store_id],
    );
    return { published_at: pub.published_at };
  },

  /** builder_list_versions(p_store_id) → { id, label, published_at }[] */
  async builder_list_versions({ p_store_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    return ctx.q(
      `SELECT id, label, published_at, configuration->>'template' AS template
         FROM public.store_theme_versions WHERE store_id = $1 ORDER BY published_at DESC`,
      [p_store_id],
    );
  },

  /** builder_restore_version(p_store_id, p_version_id) → { updated_at } (into draft) */
  async builder_restore_version({ p_store_id, p_version_id }, ctx) {
    ctx.requireAuth();
    await ctx.assertStoreAccess(p_store_id, DESIGN_ROLES);
    const v = await ctx.one(
      `SELECT configuration FROM public.store_theme_versions WHERE id = $1 AND store_id = $2`,
      [p_version_id, p_store_id],
    );
    if (!v) throw notFound('Version introuvable');
    const saved = await upsert(ctx, p_store_id, 'draft', v.configuration);
    return { updated_at: saved.updated_at, configuration: saved.configuration };
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
