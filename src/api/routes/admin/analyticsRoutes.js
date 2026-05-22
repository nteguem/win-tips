const express = require('express');
const analyticsController = require('../../controllers/admin/analyticsController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Toutes les routes analytics nécessitent une authentification admin.
router.use(adminAuth.protect);

// GET /api/admin/analytics/predictions/dashboard-mini
router.get('/predictions/dashboard-mini', analyticsController.getPredictionsDashboardMini);

module.exports = router;
