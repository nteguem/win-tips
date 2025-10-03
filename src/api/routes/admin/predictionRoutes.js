/**
 * Routes Admin pour gestion des prédictions
 */
const express = require('express');
const predictionController = require('../../controllers/common/predictionController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Protection admin sur toutes les routes
router.use(adminAuth.protect);

// CRUD complet pour admin
router.route('/')
  .get(predictionController.getPredictions)
  .post(predictionController.createPrediction);

router.route('/bulk')
  .post(predictionController.addPredictionsToTicket);

router.route('/:id')
  .get(predictionController.getPredictionById)
  .put(predictionController.updatePrediction)
  .delete(predictionController.deletePrediction);

module.exports = router;