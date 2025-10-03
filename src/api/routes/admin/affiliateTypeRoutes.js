const express = require('express');
const affiliateTypeController = require('../../controllers/admin/affiliateTypeController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

/**
 * Toutes les routes nécessitent une authentification admin
 */
router.use(adminAuth.protect);

/**
 * Routes principales
 */
router.route('/')
  .get(affiliateTypeController.getAllAffiliateTypes)     // GET /api/admin/affiliate-types
  .post(affiliateTypeController.createAffiliateType);    // POST /api/admin/affiliate-types

router.route('/stats')
  .get(affiliateTypeController.getAffiliateTypeStats);   // GET /api/admin/affiliate-types/stats

router.route('/account-count/:accountCount')
  .get(affiliateTypeController.getTypeByAccountCount);   // GET /api/admin/affiliate-types/account-count/:accountCount

router.route('/:id')
  .get(affiliateTypeController.getAffiliateType)         // GET /api/admin/affiliate-types/:id
  .put(affiliateTypeController.updateAffiliateType)      // PUT /api/admin/affiliate-types/:id
  .delete(affiliateTypeController.deleteAffiliateType);  // DELETE /api/admin/affiliate-types/:id

router.route('/:id/calculate-commission')
  .post(affiliateTypeController.calculateCommission);    // POST /api/admin/affiliate-types/:id/calculate-commission

module.exports = router;