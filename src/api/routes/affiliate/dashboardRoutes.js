const express = require('express');
const dashboardController = require('../../controllers/affiliate/dashboardController');
const commissionController = require('../../controllers/affiliate/commissionController');
const affiliateAuth = require('../../middlewares/affiliate/affiliateAuth');

const router = express.Router();

/**
 * Toutes les routes nécessitent une authentification affilié
 */
router.use(affiliateAuth.protect);

/**
 * Routes dashboard principales
 */
router.get('/stats', dashboardController.getDashboardStats);              // GET /api/affiliate/dashboard/stats
router.get('/info', dashboardController.getAffiliateInfo);               // GET /api/affiliate/dashboard/info
router.get('/summary', dashboardController.getCurrentMonthSummary);      // GET /api/affiliate/dashboard/summary

/**
 * Routes filleuls
 */
router.get('/referrals', dashboardController.getReferrals);              // GET /api/affiliate/dashboard/referrals
router.get('/referrals/search', dashboardController.searchReferrals);    // GET /api/affiliate/dashboard/referrals/search

/**
 * Routes commissions
 */
router.get('/commissions', dashboardController.getMyCommissions);        // GET /api/affiliate/dashboard/commissions
router.get('/commissions/summary', commissionController.getCommissionSummary);     // GET /api/affiliate/dashboard/commissions/summary
router.get('/commissions/pending', commissionController.getPendingCommissions);    // GET /api/affiliate/dashboard/commissions/pending
router.get('/commissions/paid', commissionController.getPaidCommissions);          // GET /api/affiliate/dashboard/commissions/paid
router.get('/commissions/periods', commissionController.getCommissionsByPeriod);   // GET /api/affiliate/dashboard/commissions/periods
router.get('/commissions/search', commissionController.searchCommissions);         // GET /api/affiliate/dashboard/commissions/search
router.get('/commissions/:id', commissionController.getCommission);                // GET /api/affiliate/dashboard/commissions/:id

/**
 * Routes analytics
 */
router.get('/earnings', dashboardController.getEarningsEvolution);       // GET /api/affiliate/dashboard/earnings
router.get('/packages', dashboardController.getTopPackages);             // GET /api/affiliate/dashboard/packages
router.get('/period-stats', dashboardController.getPeriodStats);        // GET /api/affiliate/dashboard/period-stats

module.exports = router;