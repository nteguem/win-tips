const express = require('express');
const router = express.Router();
const googlePlayController = require('../../controllers/user/googlePlayController');

// Webhook RTDN - PAS d'authentification requise (c'est Google qui appelle)
router.post('/google-play', googlePlayController.handleRTDN);



module.exports = router;