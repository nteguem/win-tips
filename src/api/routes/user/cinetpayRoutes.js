// routes/user/cinetpayRoutes.js
const express = require('express');
const cinetpayController = require('../../controllers/user/cinetpayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Routes publiques pour les callbacks
 */
// Webhook pour les notifications CinetPay (non protégé)
router.post('/webhook', cinetpayController.webhook);

/**
 * Routes protégées (authentification requise)
 */
router.use(userAuth.protect);

// Initier un paiement CinetPay
router.post('/initiate', cinetpayController.initiatePayment);

// Vérifier le statut d'un paiement
router.get('/status/:transactionId', cinetpayController.checkStatus);

// Page de retour après paiement (non protégé)
router.get('/success', cinetpayController.paymentSuccess);
router.post('/success', cinetpayController.paymentSuccess);

module.exports = router;