const express = require('express');
const affiliateController = require('../../controllers/admin/affiliateController');
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
  .get(affiliateController.getAllAffiliates)      // GET /api/admin/affiliates
  .post(affiliateController.createAffiliate);     // POST /api/admin/affiliates

router.route('/stats')
  .get(affiliateController.getAffiliateStats);    // GET /api/admin/affiliates/stats

router.route('/:id')
  .get(affiliateController.getAffiliate)          // GET /api/admin/affiliates/:id
  .put(affiliateController.updateAffiliate)       // PUT /api/admin/affiliates/:id
  .delete(affiliateController.deleteAffiliate);   // DELETE /api/admin/affiliates/:id

router.route('/:id/reset-password')
  .patch(affiliateController.resetPassword);      // PATCH /api/admin/affiliates/:id/reset-password

/**
 * Routes de gestion des commissions par affilié
 */
router.route('/:id/commissions')
  .get(affiliateController.getAffiliateCommissions);         // GET /api/admin/affiliates/:id/commissions

router.route('/:id/commissions/calculate')
  .post(affiliateController.calculateAffiliateCommissions);  // POST /api/admin/affiliates/:id/commissions/calculate

router.route('/:id/commissions/pending')
  .get(affiliateController.getPendingAffiliateCommissions);  // GET /api/admin/affiliates/:id/commissions/pending

router.route('/:id/commissions/validate-payment')
  .post(affiliateController.validateAffiliatePayment);       // POST /api/admin/affiliates/:id/commissions/validate-payment

module.exports = router;