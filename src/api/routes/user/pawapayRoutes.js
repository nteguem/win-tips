// routes/user/pawapayRoutes.js
//
// Routes pawaPay — montees a /payments/pawapay dans routes/index.js.

const express = require('express');
const pawapayController = require('../../controllers/user/pawapayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

// ---------------------------------------------
//  Routes publiques
// ---------------------------------------------
// Webhook pawaPay (callback serveur-a-serveur)
router.post('/webhook', pawapayController.webhook);

// Liste des pays + operateurs (pour le selecteur mobile)
router.get('/providers', pawapayController.getProviders);

// ---------------------------------------------
//  Routes protegees (token utilisateur requis)
// ---------------------------------------------
router.use(userAuth.protect);

router.post('/initiate', pawapayController.initiatePayment);
router.get('/status/:depositId', pawapayController.checkStatus);

module.exports = router;
