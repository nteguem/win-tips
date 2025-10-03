// routes/user/afribaPayRoutes.js
const express = require('express');
const afribaPayController = require('../../controllers/user/afribaPayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Routes publiques
 */
// Récupérer les pays et opérateurs
router.get('/countries', afribaPayController.getCountries);

// Vérifier si OTP requis 
router.get('/check-otp', afribaPayController.checkOtpRequirement);

/**
 * Webhook (non protégé)
 */
router.post('/webhook', afribaPayController.webhook);

/**
 * Routes protégées (authentification requise)
 */
router.use(userAuth.protect);

// Initier un paiement AfribaPay
router.post('/initiate', afribaPayController.initiatePayment);

// Vérifier le statut d'un paiement
router.get('/status/:orderId', afribaPayController.checkStatus);


module.exports = router;