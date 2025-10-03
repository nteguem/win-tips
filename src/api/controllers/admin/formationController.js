const formationService = require('../../services/common/formationService');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

class FormationController {

  // GET /formations - Récupérer toutes les formations
  async getFormations(req, res) {
    try {
      const { offset = 0, limit = 10, isActive, lang = 'fr' } = req.query;
           
      const result = await formationService.getFormations({
        offset: parseInt(offset),
        limit: parseInt(limit),
        isActive: isActive !== undefined ? isActive === 'true' : null,
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

  // GET /formations/:id - Récupérer une formation par ID
  async getFormationById(req, res) {
    try {
      const { id } = req.params;
      const { lang = 'fr' } = req.query;
      
      const formation = await formationService.getFormationById(id, lang);

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

  // POST /formations - Créer une nouvelle formation
  async createFormation(req, res) {
    try {
      const { title, description, htmlContent, isAccessible, requiredPackages } = req.body;
      const formationData = {
        title,
        description,
        htmlContent: htmlContent || { fr: '', en: '' },
        isAccessible: isAccessible !== undefined ? isAccessible : true,
        requiredPackages: requiredPackages || []
      };

      const formation = await formationService.createFormation(formationData);
      res.status(201);
      formatSuccess(res, {
        data: formation,
        message: 'Formation created successfully'
      });
      
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // PUT /formations/:id - Mettre à jour une formation
  async updateFormation(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;

      const formation = await formationService.updateFormation(id, updates);

      if (!formation) {
        return formatError(res, 'Formation not found', 404);
      }

      formatSuccess(res, {
        data: formation,
        message: 'Formation updated successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // DELETE /formations/:id - Désactiver une formation
  async deleteFormation(req, res) {
    try {
      const { id } = req.params;
      const formation = await formationService.deactivateFormation(id);

      if (!formation) {
        return formatError(res, 'Formation not found', 404);
      }

      formatSuccess(res, {
        data: formation,
        message: 'Formation deactivated successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }
}

module.exports = new FormationController();