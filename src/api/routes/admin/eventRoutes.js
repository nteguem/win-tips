/**
 * @fileoverview Routes simplifiées pour les événements sportifs
 * Remplace l'ancien système de routes complexe
 */

const express = require('express');
const eventController = require('../../controllers/admin/eventController');

const router = express.Router();

// ===== ROUTES PRINCIPALES =====

/**
 * GET /api/events/sports
 * Liste tous les sports configurés
 */
router.get('/sports', eventController.getConfiguredSports);

/**
 * GET /api/events/:sport
 * Liste tous les événements d'un sport
 * Query params: ?lang=fr|en
 */
router.get('/:sport', eventController.getEvents);

/**
 * GET /api/events/:sport/categories  
 * Événements groupés par catégories
 * Query params: ?lang=fr|en
 */
router.get('/:sport/categories', eventController.getEventsByCategories);

/**
 * POST /api/events/:sport/build
 * Construit un événement paramétrique
 * Body: { eventId, params, lang }
 */
router.post('/:sport/build', eventController.buildEvent);

/**
 * POST /api/events/:sport/correct
 * Corrige une prédiction unique
 * Body: { matchData, event, options }
 */
router.post('/:sport/correct', eventController.correctEvent);

/**
 * POST /api/events/:sport/correct/multiple
 * Corrige plusieurs prédictions en batch
 * Body: { matchData, predictions, options }
 */
router.post('/:sport/correct/multiple', eventController.correctMultipleEvents);

// ===== ROUTES DE DÉVELOPPEMENT =====

/**
 * GET /api/events/:sport/test-expression
 * Teste une expression avec des données d'exemple
 * Query params: ?expression=totalGoals > 2.5
 */
router.get('/:sport/test-expression', eventController.testExpression);

/**
 * POST /api/events/:sport/reload
 * Recharge la configuration d'un sport
 * Utile pour le développement sans redémarrer le serveur
 */
router.post('/:sport/reload', eventController.reloadSport);

// ===== MIDDLEWARE DE VALIDATION =====

/**
 * Middleware pour valider le paramètre sport
 */
function validateSportParam(req, res, next) {
  const { sport } = req.params;
  
  if (!sport || typeof sport !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Paramètre sport requis et doit être une chaîne'
    });
  }

  // Normaliser le sport en minuscules
  req.params.sport = sport.toLowerCase();
  next();
}

// Appliquer la validation à toutes les routes avec :sport
router.param('sport', validateSportParam);

module.exports = router;