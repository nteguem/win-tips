// src/api/routes/common/admobSsvRoutes.js
//
// Callback "Server-Side Verification" (SSV) AdMob, public (appelé par les
// serveurs Google). URL configurée dans la console AdMob sur le rewarded ad
// unit `ca-app-pub-1782439846938659/4524673447` :
//   https://api.wintips-expert.com/api/ads/admob/ssv

const express = require('express');
const admobSsvController = require('../../controllers/common/admobSsvController');

const router = express.Router();

// GET /api/ads/admob/ssv — endpoint signé par AdMob.
router.get('/admob/ssv', admobSsvController.handleRewardedSsv);

module.exports = router;
