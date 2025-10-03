const userFormationService = require('../../services/user/formationService');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

class UserFormationController {

  // GET /formations - Récupérer toutes les formations avec gestion d'accès
  async getFormations(req, res) {
    try {
      const { offset = 0, limit = 10, lang = 'fr' } = req.query;
      
      // req.user peut être undefined si l'utilisateur n'est pas connecté
      const user = req.user || null;
           
      const result = await userFormationService.getFormationsWithAccess(user, {
        offset: parseInt(offset),
        limit: parseInt(limit),
        lang
      });

      formatSuccess(res, {
        data: result.data,
        pagination: result.pagination,
        message: 'Formations retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // GET /formations/:id - Récupérer une formation par ID avec gestion d'accès
  async getFormationById(req, res) {
    try {
      const { id } = req.params;
      const { lang = 'fr' } = req.query;
      
      // req.user peut être undefined si l'utilisateur n'est pas connecté
      const user = req.user || null;
      
      const formation = await userFormationService.getFormationByIdWithAccess(id, user, lang);

      if (!formation) {
        return formatError(res, 'Formation not found', 404);
      }

      formatSuccess(res, {
        data: formation,
        message: 'Formation retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }
}

module.exports = new UserFormationController();