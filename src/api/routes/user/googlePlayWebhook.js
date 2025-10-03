const express = require('express');
const router = express.Router();
const googlePlayController = require('../../controllers/user/googlePlayController');

// Webhook RTDN - PAS d'authentification requise (c'est Google qui appelle)
router.post('/google-play', googlePlayController.handleRTDN);

// Test endpoint pour vérifier que le webhook fonctionne
router.get('/google-play/test', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Webhook Google Play opérationnel'
  });
});

module.exports = router;