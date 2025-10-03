const express = require('express');
const authController = require('../../controllers/affiliate/authController');
const affiliateAuth = require('../../middlewares/affiliate/affiliateAuth');

const router = express.Router();

/**
 * Routes publiques (sans authentification)
 */
router.post('/login', authController.login);
router.post('/refresh', affiliateAuth.verifyRefreshToken, authController.refresh);

/**
 * Routes protégées (authentification requise)
 */
router.use(affiliateAuth.protect); // Toutes les routes suivantes nécessitent une authentification

router.post('/logout', authController.logout);
router.post('/logout-all', authController.logoutAll);
router.get('/me', authController.getMe);
router.patch('/me', authController.updateMe);
router.patch('/change-password', authController.changePassword);

module.exports = router;