// controllers/categoryController.js
const categoryService = require('../../services/common/categoryService');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');
const { validateCategoryAssignment, containsEditorialField } = require('../../services/common/editorialSources');

/**
 * Normalise un champ i18n en { fr, en }.
 *  - { fr, en }       → conservé (chaque langue manquante repompée sur l'autre)
 *  - "texte" (string) → { fr: texte, en: texte }  (tolérance ancien client)
 *  - null/undefined   → null
 */
function normalizeI18n(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const v = value.trim();
    return v ? { fr: v, en: v } : null;
  }
  if (typeof value === 'object') {
    const fr = (value.fr || '').toString().trim();
    const en = (value.en || '').toString().trim();
    if (!fr && !en) return null;
    return { fr: fr || en, en: en || fr };
  }
  return null;
}

class CategoryController {

  // GET /categories - Récupérer toutes les catégories
  // `lang` (fr|en) traduit name/description. `raw=true` renvoie le format brut
  // bilingue (utile pour le backoffice qui édite les 2 langues).
  async getCategories(req, res) {
    try {
      const { offset = 0, limit = 10, isVip, isActive, lang = 'fr', raw } = req.query;

      const result = await categoryService.getCategories({
        offset: parseInt(offset),
        limit: parseInt(limit),
        isVip: isVip !== undefined ? isVip === 'true' : null,
        isActive: isActive !== undefined ? isActive === 'true' : null
      });

      formatSuccess(res, {
        data: raw === 'true'
          ? result.data
          : result.data.map(cat => cat.formatForLanguage(lang)),
        pagination: result.pagination,
        message: 'Categories retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // GET /categories/:id - Récupérer une catégorie par ID
  async getCategoryById(req, res) {
    try {
      const { id } = req.params;
      const { lang = 'fr', raw } = req.query;
      const category = await categoryService.getCategoryById(id);

      if (!category) {
        return formatError(res, 'Category not found', 404);
      }

      formatSuccess(res, {
        data: raw === 'true' ? category : category.formatForLanguage(lang),
        message: 'Category retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // POST /categories - Créer une nouvelle catégorie
  async createCategory(req, res) {
    try {
      const { name, description, icon, successRate, isVip, isActive, accessGate, externalSources, editorialSource } = req.body;
      let selectedEditorialSource;
      try { selectedEditorialSource = validateCategoryAssignment(editorialSource, isVip); }
      catch (error) { return res.status(400).json({ success: false, error: error.message }); }

      // Le nom doit être bilingue : { fr, en }. On tolère une string brute
      // (anciens clients) en la dupliquant sur les 2 langues.
      const normName = normalizeI18n(name);
      if (!normName || !normName.fr || !normName.en) {
        return formatError(res, 'Name is required with both fr and en translations', 400);
      }
      const normDesc = normalizeI18n(description) || { fr: '', en: '' };

      // Validation du successRate
      if (successRate !== undefined && (successRate < 0 || successRate > 100)) {
        return formatError(res, 'Success rate must be between 0 and 100', 400);
      }

      const categoryData = {
        name: normName,
        description: normDesc,
        icon,
        successRate,
        isActive,
        isVip: isVip,
        editorialSource: selectedEditorialSource,
      };
      // Porte de déblocage par pub : pertinente uniquement pour les free.
      // Pour la retirer côté update, envoyer `accessGate: null`.
      if (selectedEditorialSource && !isVip) categoryData.accessGate = null;
      else if (accessGate && !isVip) categoryData.accessGate = accessGate;
      // Sources externes (sync sortante bigwin -> wintips) : array filtre
      if (Array.isArray(externalSources)) {
        categoryData.externalSources = externalSources
          .filter((s) => s && s.system && s.appId && s.categoryId)
          .map((s) => ({
            system: String(s.system),
            appId: String(s.appId),
            categoryId: String(s.categoryId),
            label: s.label || '',
          }));
      }

      const category = await categoryService.createCategory(categoryData);

      res.status(201);
      formatSuccess(res, {
        data: category ? category.formatForLanguage('fr') : category,
        message: 'Category created successfully'
      });
    } catch (error) {
      if (error.code === 11000) {
        return formatError(res, 'Category name already exists', 409);
      }
      console.error('Error creating category:', error);
      formatError(res, error.message, 500);
    }
  }

  // PUT /categories/:id - Mettre à jour une catégorie
  async updateCategory(req, res) {
    try {
      const { id } = req.params;
      const updates = { ...req.body };
      const current = await categoryService.getCategoryById(id);
      if (!current) return res.status(404).json({ success: false, error: 'Category not found' });
      // Only direct JSON fields configure editorial sources; no Mongo operators.
      if ((current.editorialSource || containsEditorialField(updates)) && Object.keys(updates).some(key => key.startsWith('$') || key.includes('.'))) {
        return res.status(400).json({ success: false, error: 'Mise a jour editoriale invalide' });
      }
      if (updates.editorialSource !== undefined || current.editorialSource) {
        try {
          updates.editorialSource = validateCategoryAssignment(
            updates.editorialSource !== undefined ? updates.editorialSource : current.editorialSource,
            updates.isVip !== undefined ? updates.isVip : current.isVip,
            current.editorialSource,
          );
        } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
      }

      // Validation du successRate si présent dans les updates
      if (updates.successRate !== undefined && (updates.successRate < 0 || updates.successRate > 100)) {
        return formatError(res, 'Success rate must be between 0 and 100', 400);
      }

      // Normalise name/description en format bilingue { fr, en } si fournis.
      if (updates.name !== undefined) {
        const n = normalizeI18n(updates.name);
        if (!n || !n.fr || !n.en) {
          return formatError(res, 'Name must include both fr and en translations', 400);
        }
        updates.name = n;
      }
      if (updates.description !== undefined) {
        updates.description = normalizeI18n(updates.description) || { fr: '', en: '' };
      }

      // Si la catégorie passe en VIP, on retire automatiquement la porte.
      if (updates.isVip === true) updates.accessGate = null;
      if (updates.editorialSource && (updates.isVip !== undefined ? updates.isVip : current.isVip) === false) updates.accessGate = null;

      // Sources externes (sync sortante) : normalise et filtre les entrees invalides.
      if (Array.isArray(updates.externalSources)) {
        updates.externalSources = updates.externalSources
          .filter((s) => s && s.system && s.appId && s.categoryId)
          .map((s) => ({
            system: String(s.system),
            appId: String(s.appId),
            categoryId: String(s.categoryId),
            label: s.label || '',
          }));
      }

      const category = await categoryService.updateCategory(id, updates);

      if (!category) {
        return formatError(res, 'Category not found', 404);
      }

      formatSuccess(res, {
        data: category.formatForLanguage('fr'),
        message: 'Category updated successfully'
      });
    } catch (error) {
      if (error.code === 11000) {
        return formatError(res, 'Category name already exists', 409);
      }
      formatError(res, error.message, 500);
    }
  }

  // DELETE /categories/:id - Désactiver une catégorie
  async deleteCategory(req, res) {
    try {
      const { id } = req.params;
      const category = await categoryService.deactivateCategory(id);

      if (!category) {
        return formatError(res, 'Category not found', 404);
      }

      formatSuccess(res, {
        data: category,
        message: 'Category deactivated successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }
}

module.exports = new CategoryController();
