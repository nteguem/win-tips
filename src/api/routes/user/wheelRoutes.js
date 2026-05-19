// src/api/routes/user/wheelRoutes.js
//
// Routes user pour la "Roue de la Chance" V2 (tickets-based).

const express = require('express');
const wheelController = require('../../controllers/user/wheelController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

// Route publique (config + lots)
router.get('/config', wheelController.getConfig);

// Toutes les autres routes : auth user requise
router.use(userAuth.protect);

// Solde de tickets / stats user
router.get('/stats', wheelController.getStats);

// Spin (consomme 1 ticket, retourne le lot tiré)
router.post('/spin', wheelController.spin);

// Tickets — déblocage via pubs
router.get('/ticket-packs', wheelController.listTicketPacks);
router.post('/tickets/unlock/start', wheelController.startTicketsUnlock);
router.get('/tickets/unlock/state', wheelController.getTicketsUnlockState);

// Historique
router.get('/history', wheelController.getHistory);

// Wallet
router.get('/wallet', wheelController.getWallet);
router.get('/wallet/transactions', wheelController.getWalletTransactions);
router.post('/wallet/withdraw', wheelController.requestWithdrawal);

module.exports = router;
