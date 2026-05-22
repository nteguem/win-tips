const express = require('express');
const healthController = require('../../controllers/admin/healthController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// La santé système est réservée aux administrateurs authentifiés.
router.use(adminAuth.protect);

router.get('/', healthController.getSystemHealth); // GET /api/admin/health

module.exports = router;
