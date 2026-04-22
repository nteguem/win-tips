// routes/user/korapayRoutes.js
const express = require('express');
const korapayController = require('../../controllers/user/korapayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Route publique : page de retour utilisateur après paiement.
 * Ce projet n'utilise PAS le webhook KoraPay : la création de la souscription
 * est déclenchée soit par ce callback, soit par le cron de vérification, soit
 * par l'extension de /me.
 */
router.get('/callback', korapayController.callback);

/**
 * Routes protégées
 */
router.use(userAuth.protect);

router.post('/initiate', korapayController.initiatePayment);
router.get('/status/:reference', korapayController.checkStatus);

module.exports = router;
