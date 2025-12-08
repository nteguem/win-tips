const express = require('express');
const router = express.Router();
const googlePlayController = require('../../controllers/user/googlePlayController');
const userAuth = require('../../middlewares/user/userAuth');

// Routes protégées (utilisateur connecté)
router.use(userAuth.protect);

// ===== EXISTANT : Valider un abonnement =====
router.post('/validate-purchase', googlePlayController.validatePurchase);

// ===== NOUVEAU : Valider un produit ponctuel =====
router.post('/validate-one-time-purchase', googlePlayController.validateOneTimePurchase);

// ===== EXISTANT : Vérifier le statut de l'abonnement =====
router.get('/subscription-status', googlePlayController.getSubscriptionStatus);

// ===== EXISTANT : Acknowledge un achat =====
router.post('/acknowledge/:purchaseToken', googlePlayController.acknowledgePurchase);

// ===== EXISTANT : Obtenir les infos Google Play d'un package =====
router.get('/products/:packageId', googlePlayController.getGoogleProductInfo);

// ===== EXISTANT : Synchroniser manuellement l'abonnement =====
router.post('/sync', googlePlayController.syncSubscription);

module.exports = router;