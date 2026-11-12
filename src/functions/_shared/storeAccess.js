// Shared shop check for setup endpoints: owner/admin with a live membership AND the
// feature permission, exactly like generic REST writes (super admins always pass).
export async function canConfigureShop(ctx, storeId, permission) {
  try {
    await ctx.assertStoreAccess(storeId, ['owner', 'admin']);
    await ctx.assertStorePermission(storeId, permission);
    return true;
  } catch {
    return false;
  }
}
