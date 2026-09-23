const express = require('express');
const deviceController = require('../../controllers/common/deviceController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Routes publiques
 */
// Enregistrer un device (invité ou connecté)
router.post('/register', deviceController.registerDevice);

// Accuse de reception : publique, sans authentification. L'app l'appelle depuis
// son handler d'arriere-plan, ou aucun token utilisateur n'est disponible.
router.post('/ack', deviceController.ackNotification);

/**
 * Routes protégées (authentification requise)
 */
router.use(userAuth.protect);

// Lier device à utilisateur connecté
router.post('/link', deviceController.linkDevice);

// Délier device (déconnexion)
router.post('/unlink', deviceController.unlinkDevice);

// Désactiver device
router.delete('/:deviceId', deviceController.deactivateDevice);

module.exports = router;