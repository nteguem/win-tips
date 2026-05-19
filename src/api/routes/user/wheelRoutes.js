// src/api/routes/user/wheelRoutes.js
//
// Routes user pour la "Roue de la Chance". Le pattern reprend
// packageAdUnlockController : start (création nonce) + state (polling).
//
// Le pipeline SSV AdMob existant (admobSsvRoutes) gère les callbacks Google
// via le `nonce` — pas besoin de routes spécifiques pour les pubs.

const express = require('express');
const wheelController = require('../../controllers/user/wheelController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

// Route publique — config + lots visibles (pour pré-charger l'UI avant login)
router.get('/config', wheelController.getConfig);

// Toutes les autres routes exigent l'auth user
router.use(userAuth.protect);

// Cycle de spin
router.post('/spin/start', wheelController.startSpin);
router.get('/spin/state', wheelController.getSpinState);

// Historique
router.get('/history', wheelController.getHistory);

// Wallet
router.get('/wallet', wheelController.getWallet);
router.get('/wallet/transactions', wheelController.getWalletTransactions);
router.post('/wallet/withdraw', wheelController.requestWithdrawal);

module.exports = router;
