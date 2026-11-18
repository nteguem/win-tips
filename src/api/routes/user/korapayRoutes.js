// routes/user/korapayRoutes.js
const express = require('express');
const korapayController = require('../../controllers/user/korapayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Route publique : page de retour utilisateur après paiement.
 * Le webhook signé et le retour navigateur utilisent la même vérification
 * serveur. Le cron, /status et /me rattrapent une notification manquante.
 */
router.get('/callback', korapayController.callback);
router.post('/webhook', korapayController.webhook);

/**
 * Routes protégées
 */
router.use(userAuth.protect);

router.post('/initiate', korapayController.initiatePayment);
router.get('/status/:reference', korapayController.checkStatus);

module.exports = router;
