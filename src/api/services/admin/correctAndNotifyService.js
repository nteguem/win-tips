/**
 * @fileoverview Correction d'un ticket à la demande (admin).
 *
 * Corrige les pronostics encore 'pending' du ticket via le moteur Corrector,
 * puis recalcule le résultat consolidé du ticket.
 */
const Ticket = require('../../models/common/Ticket');
const Prediction = require('../../models/common/Prediction');
const PredictionCronService = require('../common/predictionCorrectionService');
const ticketCorrectionService = require('../common/ticketCorrectionService');
const logger = require('../../../utils/logger');

// Instance réutilisée : embarque le moteur de correction des pronostics.
const predictionCron = new PredictionCronService();

/**
 * Corrige un ticket : corrige ses pronostics 'pending' puis recalcule son
 * résultat (won / lost / pending / void).
 *
 * @param {string} ticketId
 * @returns {Promise<Object>} { ticketId, result, resultUpdatedAt, predictions }
 */
async function correctTicket(ticketId) {
  const ticket = await Ticket.findById(ticketId);
  if (!ticket) {
    const err = new Error('Ticket introuvable');
    err.statusCode = 404;
    throw err;
  }

  const predictions = await Prediction.find({ ticket: ticketId });
  let corrected = 0;
  let stillPending = 0;
  let errors = 0;

  for (const pred of predictions) {
    if (pred.status !== 'pending') continue;
    try {
      await predictionCron.processPrediction(pred);
      const fresh = await Prediction.findById(pred._id).select('status').lean();
      if (fresh && fresh.status !== 'pending') corrected++;
      else stillPending++;
    } catch (e) {
      errors++;
      logger.warn(`[correctTicket] pronostic ${pred._id} : ${e.message}`);
    }
  }

  // Recalcul du résultat consolidé du ticket.
  await ticketCorrectionService.correctTickets({ ticketIds: [ticketId] });
  const updated = await Ticket.findById(ticketId).select('result resultUpdatedAt').lean();

  return {
    ticketId,
    result: updated?.result || 'pending',
    resultUpdatedAt: updated?.resultUpdatedAt || null,
    predictions: {
      total: predictions.length,
      corrected,
      stillPending,
      errors,
    },
  };
}

module.exports = { correctTicket };
