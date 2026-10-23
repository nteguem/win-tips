/**
 * @fileoverview Catalogue public — lecture seule, sans authentification.
 *
 * Expose les catégories actives de CETTE app. Sert au backoffice WinTips
 * (et à tout autre consommateur) à proposer cette app comme « source
 * externe » : on affiche les catégories distantes, l'admin coche celles
 * qu'il veut absorber, et la synchro sortante de la source clonera ses
 * tickets dans la catégorie WinTips correspondante.
 *
 * Format aligné sur l'API publique de BigWin v2 :
 *   { _id, appId, appIds, name, description, icon, isVip }
 *
 * `appId` est ici synthétisé depuis la variable d'env `APP_ID` (chaque
 * déploiement définit la sienne : `wintips`, `predictfoot`…). Le champ
 * `appIds` est rempli avec le même identifiant pour rester compatible
 * avec le format BigWin (qui supporte le multi-tenant).
 *
 * ⚠️ V1 : pas d'authentification. À protéger en V2 par IP allow-list ou
 * token partagé.
 */
const Category = require('../../models/common/Category');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

const APP_ID = process.env.APP_ID || 'app';

/**
 * GET /api/public/catalog/categories
 * Retourne toutes les catégories actives au format aplati (FR par défaut).
 */
exports.listAllCategories = async (req, res) => {
  try {
    const cats = await Category.find({ isActive: true })
      .select('_id name description icon isVip')
      .sort({ _id: 1 })
      .lean();

    const formatted = cats.map((c) => ({
      _id: String(c._id),
      appId: APP_ID,
      appIds: [APP_ID],
      name:
        (c.name && (c.name.fr || c.name.en)) ||
        (typeof c.name === 'string' ? c.name : ''),
      description:
        (c.description && (c.description.fr || c.description.en)) ||
        (typeof c.description === 'string' ? c.description : ''),
      icon: c.icon,
      isVip: !!c.isVip,
    }));

    return formatSuccess(res, { data: formatted });
  } catch (err) {
    return formatError(res, err.message, 500);
  }
};
