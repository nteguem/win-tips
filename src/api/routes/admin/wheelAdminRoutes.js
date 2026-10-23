// src/api/routes/admin/wheelAdminRoutes.js
//
// Routes admin pour la gestion de la roue. Toutes exigent une auth admin.

const express = require('express');
const wheelAdminController = require('../../controllers/admin/wheelAdminController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

router.use(adminAuth.protect);

// ====== Config globale ======
router.route('/config')
  .get(wheelAdminController.getConfig)
  .put(wheelAdminController.updateConfig);

// ====== Lots (CRUD) ======
router.route('/prizes')
  .get(wheelAdminController.listPrizes)
  .post(wheelAdminController.createPrize);

router.route('/prizes/:id')
  .put(wheelAdminController.updatePrize)
  .delete(wheelAdminController.deletePrize);

router.patch('/prizes/:id/toggle', wheelAdminController.togglePrize);

// ====== Spins / historique ======
router.get('/spins', wheelAdminController.listSpins);
router.post('/spins/:id/mark-delivered', wheelAdminController.markDelivered);
router.post('/spins/:id/mark-paid', wheelAdminController.markPaid);

// ====== Retraits cash ======
router.get('/withdrawals', wheelAdminController.listWithdrawalRequests);
router.post('/withdrawals/:id/complete', wheelAdminController.completeWithdrawal);
router.post('/withdrawals/:id/cancel', wheelAdminController.cancelWithdrawal);

// ====== Stats ======
router.get('/stats', wheelAdminController.getStats);

module.exports = router;
