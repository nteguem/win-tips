const express = require('express');
const userController = require('../../controllers/admin/userController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Toutes les routes nécessitent une authentification admin.
router.use(adminAuth.protect);

router.get('/stats', userController.getUserStats); // GET /api/admin/users/stats
router.get('/', userController.getUsers); // GET /api/admin/users
router.get('/:id', userController.getUser); // GET /api/admin/users/:id
router.patch('/:id/toggle-status', userController.toggleUserStatus); // PATCH /api/admin/users/:id/toggle-status

module.exports = router;
