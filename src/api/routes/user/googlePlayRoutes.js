const express = require('express');
const router = express.Router();
const googlePlayController = require('../../controllers/user/googlePlayController');
const userAuth = require('../../middlewares/user/userAuth');

// Routes protégées (utilisateur connecté)
router.use(userAuth.protect);

// Valider un achat
router.post('/validate-purchase', googlePlayController.validatePurchase);

// Vérifier le statut de l'abonnement
router.get('/subscription-status', googlePlayController.getSubscriptionStatus);

// Acknowledge un achat
router.post('/acknowledge/:purchaseToken', googlePlayController.acknowledgePurchase);

// Obtenir les infos Google Play d'un package
router.get('/products/:packageId', googlePlayController.getGoogleProductInfo);

// Synchroniser manuellement l'abonnement
router.post('/sync', googlePlayController.syncSubscription);

module.exports = router;