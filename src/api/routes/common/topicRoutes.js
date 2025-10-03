// routes/common/topicRoutes.js
const express = require('express');
const topicController = require('../../controllers/common/topicController');

const router = express.Router();

/**
 * Routes publiques
 */
// Créer un topic
router.post('/', topicController.createTopic);

// Obtenir topics (avec filtre par ville)
router.get('/', topicController.getTopics);

// Obtenir topic par ID
router.get('/:id', topicController.getTopicById);

// Mettre à jour topic
router.put('/:id', topicController.updateTopic);

// Désactiver topic
router.delete('/:id', topicController.deactivateTopic);

module.exports = router;