// Storefront (Public) — spec 3.9. Anonymous callers allowed; only expose
// data belonging to active/published stores & pages.

async function assertPublicStore(ctx, storeId) {
  const store = await ctx.one(
    `SELECT id FROM public.platform_stores WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [storeId],
  );
  return !!store;
}

export default {
  /** get_store_public_settings(p_store_id) → { key, value }[] */
  async get_store_public_settings({ p_store_id }, ctx) {
    if (!(await assertPublicStore(ctx, p_store_id))) return [];
    return ctx.q('SELECT key, value FROM public.store_settings WHERE store_id = $1 ORDER BY key', [p_store_id]);
  },

  /** get_store_public_pixels(p_store_id) → { key, value }[] */
  async get_store_public_pixels({ p_store_id }, ctx) {
    if (!(await assertPublicStore(ctx, p_store_id))) return [];
    return ctx.q(
      `SELECT key, value FROM public.store_settings
        WHERE store_id = $1 AND key ILIKE 'pixel_%'
        ORDER BY key`,
      [p_store_id],
    );
  },

  /** get_store_active_theme(p_store_id) → Json theme configuration */
  async get_store_active_theme({ p_store_id }, ctx) {
    if (!(await assertPublicStore(ctx, p_store_id))) return null;
    const instance = await ctx.one(
      `SELECT ti.configuration, ti.theme_definition_id, ti.preset_id,
              tp.key AS preset_key, tp.tokens, td.key AS family_key
         FROM public.store_theme_instances ti
         JOIN public.theme_presets tp ON tp.id = ti.preset_id
         JOIN public.theme_definitions td ON td.id = ti.theme_definition_id
        WHERE ti.store_id = $1 AND ti.status = 'published'
        ORDER BY ti.published_at DESC NULLS LAST
        LIMIT 1`,
      [p_store_id],
    );
    if (instance) {
      return {
        configuration: instance.configuration,
        theme_definition_id: instance.theme_definition_id,
        preset_id: instance.preset_id,
        presetKey: instance.preset_key,
        familyKey: instance.family_key,
        tokens: { ...instance.tokens, ...(instance.configuration || {}) },
      };
    }
    const legacy = await ctx.one(
      `SELECT theme_id, primary_color, secondary_color, logo_url
         FROM public.store_theme WHERE store_id = $1`,
      [p_store_id],
    );
    if (!legacy) return null;
    return {
      presetKey: legacy.theme_id || 'oslo',
      familyKey: legacy.theme_id === 'dakar' ? 'conversion' : null,
      tokens: { primary: legacy.primary_color, accent: legacy.secondary_color },
      logo_url: legacy.logo_url,
    };
  },

  /** increment_sales_page_visit(p_page_id) → void */
  async increment_sales_page_visit({ p_page_id }, ctx) {
    await ctx.q(
      `UPDATE public.store_sales_pages SET visits = visits + 1 WHERE id = $1 AND status = 'published'`,
      [p_page_id],
    );
    return null;
  },

  /** get_phone_verification_public_flags() → { enabled, force_verification, provider }[] */
  async get_phone_verification_public_flags(_args, ctx) {
    const rows = await ctx.q(
      `SELECT enabled, force_verification, provider FROM public.phone_verification_settings LIMIT 1`,
    );
    return rows;
  },
};
