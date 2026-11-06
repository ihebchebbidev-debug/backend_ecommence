// Server mirror of the web DEFAULT_ROLE_PERMISSIONS (src/lib/storeRoles.ts).
// Used when a shop never saved a value for a role/permission, so unset grants
// follow the same defaults the Équipe/roles screen shows.
const ALL = ['canViewDashboard','canManageProducts','canManageOrders','canManageCustomers','canManageCoupons','canManageInventory','canManageSettings','canManageTeam','canViewAnalytics','canManagePayments','canManageVerification','canExportData','canManageAutomations'];
const grant = (keys) => Object.fromEntries(ALL.map((k) => [k, keys.includes(k)]));

export const ROLE_PERMISSION_KEYS = ALL;
export const DEFAULT_ROLE_PERMISSIONS = {
  owner: grant(ALL),
  admin: grant(ALL.filter((k) => k !== 'canManageVerification')),
  manager: grant(['canViewDashboard','canManageProducts','canManageOrders','canManageCustomers','canManageCoupons','canManageInventory','canViewAnalytics','canExportData','canManageAutomations']),
  seller: grant(['canViewDashboard','canManageOrders','canManageCustomers']),
  support: grant(['canViewDashboard','canManageOrders','canManageCustomers']),
  accountant: grant(['canViewDashboard','canViewAnalytics','canManagePayments','canExportData']),
  viewer: grant(['canViewDashboard']),
};

/** Effective permission: saved value wins; unset keys fall back to the role default. */
export function effectivePermission(role, saved, permission) {
  if (role === 'owner') return true;
  if (Array.isArray(saved)) return saved.includes(permission);
  if (saved && typeof saved === 'object' && typeof saved[permission] === 'boolean') return saved[permission];
  const defaults = DEFAULT_ROLE_PERMISSIONS[role];
  if (defaults && Object.prototype.hasOwnProperty.call(defaults, permission)) return defaults[permission];
  return role === 'admin';
}
