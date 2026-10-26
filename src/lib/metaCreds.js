// Seller Meta (Facebook) credentials: the pixel ID is public (store_settings),
// the Conversions API token is private (store_meta_capi, REST-denied).
export const META_GRAPH = 'https://graph.facebook.com/v26.0';

export async function getMetaCreds(ctx, storeId) {
  const [pix, cap] = await Promise.all([
    ctx.q(`SELECT value FROM public.store_settings WHERE store_id=$1 AND key='meta_pixel_id'`, [storeId]).then((r) => r[0]?.value || null),
    ctx.q(`SELECT access_token, test_event_code FROM public.store_meta_capi WHERE store_id=$1`, [storeId]).then((r) => r[0] || null),
  ]);
  return { pixelId: pix ? String(pix).trim() : null, accessToken: cap?.access_token || null, testEventCode: cap?.test_event_code || null };
}

/** Ask Meta whether this token can use this pixel. Returns { ok, name?, lastFired?, error? }. */
export async function verifyPixelToken(pixelId, token, fetchImpl = fetch) {
  try {
    const url = `${META_GRAPH}/${encodeURIComponent(pixelId)}?fields=id,name,last_fired_time`;
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => ({}));
    // Provider error text can echo credentials; return safe, actionable categories only.
    if (!r.ok || d.error) return { ok: false, error: d.error?.code === 190 ? 'META_TOKEN_EXPIRED' : d.error?.code === 10 || d.error?.code === 200 ? 'META_PERMISSION_DENIED' : 'META_VERIFICATION_FAILED' };
    if (String(d.id) !== String(pixelId)) return { ok: false, error: 'META_PIXEL_MISMATCH' };
    return { ok: true, name: d.name || null, lastFired: d.last_fired_time || null };
  } catch {
    return { ok: false, error: 'Could not reach Meta' };
  }
}

/** Only an active shop owner/admin or a full platform super-admin manages credentials. */
export async function canManageMeta(ctx, storeId) {
  if (!ctx.userId || !(await ctx.isActiveUser())) return false;
  if ((await ctx.myAdminRole()) === 'super_admin') return true;
  const owner = await ctx.q('SELECT 1 FROM public.platform_stores WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [storeId, ctx.userId]);
  if (owner.length) return true;
  const member = await ctx.q(`SELECT role FROM public.store_members WHERE store_id=$1 AND user_id=$2 AND status='active'`, [storeId, ctx.userId]);
  return ['owner', 'admin'].includes(member[0]?.role);
}
