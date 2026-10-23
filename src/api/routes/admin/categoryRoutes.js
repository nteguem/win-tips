/**
 * Routes Admin pour gestion des catégories
 */
const express = require('express');
const categoryController = require('../../controllers/common/categoryController');
const adminAuth = require('../../middlewares/admin/adminAuth');
const { containsEditorialField } = require('../../services/common/editorialSources');

const router = express.Router();

// Keep legacy route permissions unchanged. New editorial configuration, and
// writes to a category using it, always require a real admin session.
function protectEditorialWrite(req, res, next) {
  Promise.resolve().then(async () => {
    let selected = false;
    if (req.params.id) {
      const Category = require('../../models/common/Category');
      const category = await Category.findById(req.params.id).select('editorialSource').lean();
      selected = !!(category && category.editorialSource);
    }
    if (selected || containsEditorialField(req.body)) return adminAuth.protect(req, res, next);
    return next();
  }).catch(next);
}

// Protection admin sur toutes les routes
// router.use(adminAuth.protect);

// CRUD complet pour admin
router.route('/')
  .get(categoryController.getCategories)
  .post(protectEditorialWrite, categoryController.createCategory);

router.route('/:id')
  .get(categoryController.getCategoryById)
  .put(protectEditorialWrite, categoryController.updateCategory)
  .delete(protectEditorialWrite, categoryController.deleteCategory);

module.exports = router;
