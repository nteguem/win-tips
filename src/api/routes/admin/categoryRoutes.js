/**
 * Routes Admin pour gestion des catégories
 */
const express = require('express');
const categoryController = require('../../controllers/common/categoryController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Protection admin sur toutes les routes
router.use(adminAuth.protect);

// CRUD complet pour admin
router.route('/')
  .get(categoryController.getCategories)
  .post(categoryController.createCategory);

router.route('/:id')
  .get(categoryController.getCategoryById)
  .put(categoryController.updateCategory)
  .delete(categoryController.deleteCategory);

module.exports = router;