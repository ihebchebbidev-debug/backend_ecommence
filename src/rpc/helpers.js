// 3.12 Helper/Guard Functions — thin wrappers over ctx's auth.uid()-equivalents.
export default {
  /** is_super_admin() → boolean */
  async is_super_admin(_args, ctx) {
    return ctx.isSuperAdmin();
  },

  /** _is_super_admin() → boolean (internal alias) */
  async _is_super_admin(_args, ctx) {
    return ctx.isSuperAdmin();
  },

  /** is_any_admin() → boolean */
  async is_any_admin(_args, ctx) {
    return ctx.isAnyAdmin();
  },

  /** is_active_user() → boolean */
  async is_active_user(_args, ctx) {
    return ctx.isActiveUser();
  },

  /** is_phone_verified() → boolean */
  async is_phone_verified(_args, ctx) {
    return ctx.isPhoneVerified();
  },

  /** my_admin_role() → string|null */
  async my_admin_role(_args, ctx) {
    return ctx.myAdminRole();
  },

  /** _user_store_role(p_store_id) → string|null (internal) */
  async _user_store_role({ p_store_id }, ctx) {
    return ctx.storeRole(p_store_id);
  },
};
