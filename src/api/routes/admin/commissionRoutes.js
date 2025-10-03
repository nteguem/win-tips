const express = require('express');
const commissionController = require('../../controllers/admin/commissionController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

/**
 * Toutes les routes nécessitent une authentification admin
 */
router.use(adminAuth.protect);

/**
 * Routes globales et maintenance uniquement
 */
router.route('/stats')
  .get(commissionController.getCommissionStats);        // GET /api/admin/commissions/stats

router.route('/cancel')
  .post(commissionController.cancelCommissions);         // POST /api/admin/commissions/cancel

router.route('/recalculate-balances')
  .post(commissionController.recalculateBalances);       // POST /api/admin/commissions/recalculate-balances

module.exports = router;