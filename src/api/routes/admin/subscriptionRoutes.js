const express = require('express');
const subscriptionController = require('../../controllers/admin/subscriptionController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Toutes les routes nécessitent une authentification admin.
router.use(adminAuth.protect);

router.get('/stats', subscriptionController.getSubscriptionStats); // GET /api/admin/subscriptions/stats
router.get('/', subscriptionController.getSubscriptions); // GET /api/admin/subscriptions

module.exports = router;
