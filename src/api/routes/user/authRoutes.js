const express = require('express');
const authController = require('../../controllers/user/authController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Routes publiques (sans authentification)
 */
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh', userAuth.verifyRefreshToken, authController.refresh);
router.post('/reset-password', authController.resetPassword); 

/**
 * Routes protégées (authentification requise)
 */
router.use(userAuth.protect); // Toutes les routes suivantes nécessitent une authentification

router.post('/logout', authController.logout);
router.post('/logout-all', authController.logoutAll);
router.get('/me', authController.getMe);
router.patch('/me', authController.updateMe);
router.patch('/change-password', authController.changePassword);

module.exports = router;