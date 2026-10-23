// src/api/routes/common/devAccessRoutes.js
//
// Routes DEV. Montées uniquement si `process.env.ENABLE_DEV_REWARDS === 'true'`
// (cf. routes/index.js). Permettent de simuler un callback SSV sans passer par
// AdMob — indispensable parce qu'AdMob ne déclenche pas la SSV sur les pubs de
// test / les test devices.

const express = require('express');
const admobSsvController = require('../../controllers/common/admobSsvController');

const router = express.Router();

// POST /api/dev/access/simulate-reward  { nonce, userId?, transactionId? }
router.post('/access/simulate-reward', admobSsvController.simulateReward);

module.exports = router;
