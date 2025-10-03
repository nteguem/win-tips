const express = require('express');
const packageController = require('../../controllers/admin/packageController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();
router.route('/')
  .get(packageController.getAllPackages) 
/**
 * Toutes les routes nécessitent une authentification admin
 */
router.use(adminAuth.protect);

/**
 * Routes principales
 */
router.route('/')
  .post(packageController.createPackage);     // POST /api/admin/packages

router.route('/stats')
  .get(packageController.getPackageStats);    // GET /api/admin/packages/stats

router.route('/:id')
  .get(packageController.getPackage)          // GET /api/admin/packages/:id
  .put(packageController.updatePackage)       // PUT /api/admin/packages/:id
  .delete(packageController.deletePackage);   // DELETE /api/admin/packages/:id

router.route('/:id/toggle')
  .patch(packageController.togglePackageStatus); // PATCH /api/admin/packages/:id/toggle

module.exports = router;