/**
 * @fileoverview Point d'entrée des routes API pour le système WinTips
 * Centralise toutes les routes par type d'utilisateur
 */
const express = require('express');

const router = express.Router();

// ===== ROUTES D'AUTHENTIFICATION =====
const adminAuthRoutes = require('./admin/authRoutes');
const affiliateAuthRoutes = require('./affiliate/authRoutes');
const userAuthRoutes = require('./user/authRoutes');

router.use('/admin/auth', adminAuthRoutes);
router.use('/affiliate/auth', affiliateAuthRoutes);
router.use('/user/auth', userAuthRoutes);

// ===== ROUTES ADMIN =====
const adminPackageRoutes = require('./admin/packageRoutes');
const adminCategoryRoutes = require('./admin/categoryRoutes');
const adminTicketRoutes = require('./admin/ticketRoutes');
const adminPredictionRoutes = require('./admin/predictionRoutes');
const adminSportsRoutes = require('./admin/sportsRoutes');
const adminEventRoutes = require('./admin/eventRoutes');
const adminAffiliateRoutes = require('./admin/affiliateRoutes');
const adminCommissionRoutes = require('./admin/commissionRoutes');
const adminAffiliateTypeRoutes = require('./admin/affiliateTypeRoutes');
const adminFormationRoutes = require('./admin/formationRoutes'); 

router.use('/admin/packages', adminPackageRoutes);
router.use('/admin/categories', adminCategoryRoutes);
router.use('/admin/tickets', adminTicketRoutes);
router.use('/admin/predictions', adminPredictionRoutes);
router.use('/admin/sports', adminSportsRoutes);
router.use('/admin/events', adminEventRoutes);
router.use('/admin/affiliates', adminAffiliateRoutes);
router.use('/admin/commissions', adminCommissionRoutes);
router.use('/admin/affiliate-types', adminAffiliateTypeRoutes);
router.use('/admin/formations', adminFormationRoutes);

// ===== ROUTES INTERNES (sync sortante depuis bigwin) =====
// ⚠️ V1 : pas d'auth. Voir internalSyncController pour le plan V2.
const internalSyncRoutes = require('./common/internalSyncRoutes');
router.use('/internal/sync', internalSyncRoutes);

// ===== ROUTES AFFILIATE =====
const affiliateDashboardRoutes = require('./affiliate/dashboardRoutes');

router.use('/affiliate/dashboard', affiliateDashboardRoutes);

// ===== ROUTES USER =====
const userSubscriptionRoutes = require('./user/subscriptionRoutes');
const couponRoutes = require('./user/couponRoutes');
const accessRoutes = require('./user/accessRoutes');
const smobilpayRoutes = require('./user/smobilpayRoutes');
const cinetpayRoutes = require('./user/cinetpayRoutes');
const afribaPayRoutes = require('./user/afribaPayRoutes');
const korapayRoutes = require('./user/korapayRoutes');
const userFormationRoutes = require('./user/formationRoutes');
const googlePlayRoutes = require('./user/googlePlayRoutes');
const googlePlayWebhook = require('./user/googlePlayWebhook');
const packageRoutes = require('./user/packageRoutes');
router.use('/user/coupons', couponRoutes);
router.use('/user/packages', packageRoutes);
router.use('/user/formations', userFormationRoutes);
router.use('/user/access', accessRoutes);
router.use('/user', userSubscriptionRoutes);
router.use('/user/google-play', googlePlayRoutes);
router.use('/webhooks', googlePlayWebhook);

// ===== ROUTES COMMON =====
const deviceRoutes = require('./common/deviceRoutes');
const topicRoutes = require('./common/topicRoutes');
const notificationRoutes = require('./common/notificationRoutes');
const configRoutes = require('./common/configRoutes');
const admobSsvRoutes = require('./common/admobSsvRoutes');

router.use('/devices', deviceRoutes);
router.use('/topics', topicRoutes);
router.use('/notifications', notificationRoutes);
router.use('/config', configRoutes);
// Callback SSV AdMob — public (appelé par les serveurs Google).
router.use('/ads', admobSsvRoutes);

// ===== ROUTES DEV (gardées par variable d'env, 404 sinon) =====
if (process.env.ENABLE_DEV_REWARDS === 'true') {
  const devAccessRoutes = require('./common/devAccessRoutes');
  router.use('/dev', devAccessRoutes);
}

// ===== POINT D'ENTRÉE API =====
// Routes de paiement Smobilpay
router.use('/payments/smobilpay', smobilpayRoutes);
// Routes de paiement CinetPay
router.use('/payments/cinetpay', cinetpayRoutes);
// Routes de paiement AfribaPay
router.use('/payments/afribapay', afribaPayRoutes);
// Routes de paiement KoraPay (NG, GH, KE, ZA, EG, CI)
router.use('/payments/korapay', korapayRoutes);

/**
 * GET /api/
 * Documentation des endpoints disponibles
 */
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'WinTips API v1',
    version: '1.0.0',
  });
});

module.exports = router;