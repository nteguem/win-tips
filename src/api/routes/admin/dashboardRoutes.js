const express = require('express');
const dashboardController = require('../../controllers/admin/dashboardController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Toutes les routes du dashboard nécessitent une authentification admin.
router.use(adminAuth.protect);

router.get('/stats', dashboardController.getDashboardStats); // GET /api/admin/dashboard/stats

module.exports = router;
