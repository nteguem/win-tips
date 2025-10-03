/**
 * @fileoverview Contrôleur simplifié pour les événements sportifs - VERSION CORRIGÉE
 * Toutes les réponses utilisent la structure data: {} pour formatSuccess
 */

const EventManager = require('../../../core/events/EventManager');
const Corrector = require('../../../core/events/Corrector');
const { AppError } = require('../../../utils/errorHandler');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

// Instances uniques
const eventManager = new EventManager();
const corrector = new Corrector();

/**
 * GET /api/events/:sport
 */
exports.getEvents = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const { lang = 'fr' } = req.query;

    const events = eventManager.getEvents(sport, lang);

    formatSuccess(res, {
      data: {
        sport: sport,
        configured: events.configured,
        locale: lang,
        message: events.message || null,
        events: events.data,
        meta: events.meta
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/events/:sport/categories
 */
exports.getEventsByCategories = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const { lang = 'fr' } = req.query;

    const categorizedEvents = eventManager.getEventsByCategory(sport, lang);

    formatSuccess(res, {
      data: {
        sport: sport,
        configured: categorizedEvents.configured,
        locale: lang,
        message: categorizedEvents.message || null,
        categories: categorizedEvents.data,
        categoriesList: categorizedEvents.categories
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/events/:sport/build
 */
exports.buildEvent = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const { eventId, params = {}, lang = 'fr' } = req.body;

    if (!eventId) {
      throw new AppError('ID événement requis', 400);
    }

    const validation = eventManager.validateEvent(sport, eventId);
    if (!validation.valid) {
      throw new AppError(validation.error, 400);
    }

    const result = eventManager.buildEvent(sport, eventId, params, lang);

    formatSuccess(res, {
      data: {
        sport: sport,
        eventId: eventId,
        locale: lang,
        event: result.event,
        warnings: result.warnings,
        meta: {
          parametric: validation.eventInfo.parametric,
          category: validation.eventInfo.category,
          timestamp: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/events/:sport/correct
 */
exports.correctEvent = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const { matchData, event, options = {} } = req.body;

    if (!matchData) {
      throw new AppError('Données de match requises', 400);
    }

    if (!event || !event.id) {
      throw new AppError('Événement requis avec ID', 400);
    }

    const eventValidation = eventManager.validateEvent(sport, event.id);
    if (!eventValidation.valid) {
      throw new AppError(eventValidation.error, 400);
    }

    // Construire l'événement paramétrique si nécessaire
    let finalEvent = event;
    if (eventValidation.eventInfo.parametric && event.params && !event.expression) {
      const buildResult = eventManager.buildEvent(sport, event.id, event.params, options.locale || 'fr');
      if (!buildResult.success) {
        throw new AppError(`Erreur construction événement: ${buildResult.error}`, 400);
      }
      finalEvent = buildResult.event;
    }

    const tempPrediction = {
      id: `temp_${Date.now()}`,
      event: finalEvent
    };

    const correctionResult = corrector.correctPrediction(tempPrediction, matchData, sport);
    const matchInfo = extractMatchInfo(matchData);
    const eventInfo = extractEventInfo(finalEvent, eventValidation.eventInfo);

    formatSuccess(res, {
      data: {
        sport: sport,
        eventId: event.id,
        matchId: matchData.id,
        correction: {
          success: correctionResult.success,
          canCorrect: correctionResult.correction.canCorrect,
          result: correctionResult.correction.result,
          confidence: correctionResult.correction.confidence,
          reason: correctionResult.correction.reason,
          expression: correctionResult.correction.expression
        },
        validation: {
          match: {
            valid: correctionResult.success || correctionResult.correction.canCorrect,
            status: matchData.status,
            hasScore: matchData.score?.home !== undefined && matchData.score?.away !== undefined,
            hasDetails: !!matchData.score?.details
          },
          event: {
            valid: eventValidation.valid,
            exists: eventValidation.exists,
            parametric: eventValidation.eventInfo.parametric,
            category: eventValidation.eventInfo.category
          }
        },
        evaluation: correctionResult.evaluation,
        metadata: {
          matchInfo: matchInfo,
          eventInfo: eventInfo,
          timestamp: correctionResult.timestamp
        }
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/events/:sport/correct/multiple
 */
exports.correctMultipleEvents = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const { matchData, predictions, options = {} } = req.body;

    if (!matchData) {
      throw new AppError('Données de match requises', 400);
    }

    if (!Array.isArray(predictions) || predictions.length === 0) {
      throw new AppError('Liste de prédictions requise', 400);
    }

    for (const prediction of predictions) {
      if (!prediction.event?.id) {
        throw new AppError('Chaque prédiction doit avoir un événement avec ID', 400);
      }

      const eventValidation = eventManager.validateEvent(sport, prediction.event.id);
      if (!eventValidation.valid) {
        throw new AppError(`Événement ${prediction.event.id}: ${eventValidation.error}`, 400);
      }
    }

    const tempPredictions = predictions.map((pred, index) => ({
      id: pred.id || `temp_${Date.now()}_${index}`,
      event: pred.event
    }));

    const correctionResults = corrector.correctMultiple(tempPredictions, matchData, sport);

    const enrichedResults = correctionResults.results.map((result, index) => ({
      ...result,
      metadata: {
        originalPrediction: predictions[index],
        eventInfo: extractEventInfo(predictions[index].event)
      }
    }));

    formatSuccess(res, {
      data: {
        sport: sport,
        matchId: matchData.id,
        total: correctionResults.total,
        success: correctionResults.success,
        failed: correctionResults.failed,
        results: enrichedResults,
        summary: {
          ...correctionResults.summary,
          matchInfo: extractMatchInfo(matchData),
          successRate: correctionResults.summary.successRate + '%'
        }
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/events/:sport/test-expression
 */
exports.testExpression = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const { expression } = req.query;

    if (!expression) {
      throw new AppError('Expression requise', 400);
    }

    const testResult = corrector.testExpression(expression, sport);

    formatSuccess(res, {
      data: {
        sport: sport,
        expression: expression,
        test: testResult,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/events/sports
 */
exports.getConfiguredSports = async (req, res, next) => {
  try {
    const configuredSports = eventManager.getConfiguredSports();
    const debugInfo = eventManager.getDebugInfo();

    formatSuccess(res, {
      data: {
        sports: configuredSports,
        total: configuredSports.length,
        debug: debugInfo,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/events/:sport/reload
 */
exports.reloadSport = async (req, res, next) => {
  try {
    const { sport } = req.params;

    const reloaded = eventManager.reloadSport(sport);

    formatSuccess(res, {
      data: {
        sport: sport,
        reloaded: reloaded,
        message: reloaded ? 
          `Sport ${sport} rechargé avec succès` : 
          `Échec du rechargement de ${sport}`,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Utilitaires
 */
function extractMatchInfo(matchData) {
  return {
    id: matchData.id,
    status: matchData.status,
    date: matchData.date,
    score: matchData.score ? {
      home: matchData.score.home,
      away: matchData.score.away,
      total: (matchData.score.home || 0) + (matchData.score.away || 0)
    } : null,
    teams: {
      home: matchData.teams?.home?.name || 'Équipe domicile',
      away: matchData.teams?.away?.name || 'Équipe extérieur'
    },
    league: matchData.league?.name || null
  };
}

function extractEventInfo(event, validationInfo = null) {
  return {
    id: event.id,
    label: event.label,
    expression: event.expression,
    category: event.category || validationInfo?.category || null,
    priority: event.priority || validationInfo?.priority || null,
    parametric: event.parametric || validationInfo?.parametric || false,
    params: event.params || null
  };
}