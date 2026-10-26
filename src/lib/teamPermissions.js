import { badRequest } from './errors.js';

export const TEAM_ROLES = ['agent','confirmation','stock','designer','tech','manager','admin','orders','custom','readonly'];
export const TEAM_PERMISSION_KEYS = ['commandes','produits','categories','personnel','boutique','statistiques','calculateur','gestionnaire','paiement','credits_ia','codes_promo','clients','livraison','avis','marketing','integrations','repartition','regles_repartition'];
export function validateTeamAccess(role, permissions) {
  if (!TEAM_ROLES.includes(role)) throw badRequest('Invalid team role');
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw badRequest('Invalid permissions');
  for (const [key, flags] of Object.entries(permissions)) {
    if (!TEAM_PERMISSION_KEYS.includes(key) || !flags || typeof flags !== 'object' || Array.isArray(flags)
      || Object.entries(flags).some(([action, value]) => !['read','create','modify','delete'].includes(action) || typeof value !== 'boolean')) throw badRequest('Invalid permissions');
  }
}