// routes/user/smobilpayRoutes.js
const express = require('express');
const smobilpayController = require('../../controllers/user/smobilpayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();
/**
 * Routes publiques
 */
// Récupérer les services par pays
router.get('/services', smobilpayController.getServices);

/**
 * Webhook (non protégé pour permettre les callbacks Smobilpay)
 */
router.post('/webhook', smobilpayController.webhook);

/**
 * Routes protégées (authentification requise)
 */
router.use(userAuth.protect);

// Initier un paiement
router.post('/initiate', smobilpayController.initiatePayment);

// Vérifier le statut d'un paiement
router.get('/status/:paymentId', smobilpayController.checkStatus);


module.exports = router;