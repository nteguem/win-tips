const express = require('express');
const couponController = require('../../controllers/user/couponController');
const userAuth = require('../../middlewares/user/userAuth');
const vipAccess = require('../../middlewares/user/checkSubscription');

const router = express.Router();

/**
 * Middleware conditionnel qui applique l'authentification et la vérification VIP
 * seulement quand isVip=true
 */
const conditionalVipMiddleware = (req, res, next) => {
  const isVip = req.query.isVip === 'true';
  
  if (isVip) {
    // Pour les coupons VIP : authentification + vérification VIP
    userAuth.protect(req, res, (authErr) => {
      if (authErr) return next(authErr);
      
      vipAccess.checkCouponsVipAccess(req, res, next);
    });
  } else {
    // Pour les coupons gratuits : accès public
    next();
  }
};

/**
 * Routes pour les coupons
 * La différenciation free/vip se fait via le paramètre 'isVip' dans la query
 * Exemples d'utilisation :
 * - GET /coupons?isVip=false                    // Coupons gratuits (accès public)
 * - GET /coupons?isVip=true                     // Coupons VIP (authentification + VIP requis)
 * - GET /coupons                                // Coupons gratuits (accès public)
 * - GET /coupons?isVip=true&date=2025-07-31     // Coupons VIP pour une date
 * - GET /coupons?isVip=false&category=categoryId&page=1&limit=20
 */

// Récupérer tous les coupons avec middleware conditionnel
router.get('/', conditionalVipMiddleware, couponController.getCoupons);

// Récupérer l'historique des tickets avec middleware conditionnel
router.get('/history', conditionalVipMiddleware, couponController.getTicketsHistory);

module.exports = router;