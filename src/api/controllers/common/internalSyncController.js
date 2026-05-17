// src/api/controllers/common/internalSyncController.js
//
// =====================================================================
// ⚠️  ROUTES PUBLIQUES SANS AUTH — V1 INTERNE
// =====================================================================
// Endpoints appeles par bigwin a chaque publication de ticket. Wintips
// resout LUI-MEME si une de ses categories veut absorber ce ticket via
// son champ `Category.externalSources`.
//
// V1 = pas d'authentification. A proteger en V2 par cle partagee ou IP.
// =====================================================================

const ticketService = require('../../services/common/ticketService');
const predictionService = require('../../services/common/predictionService');
const Category = require('../../models/common/Category');
const Ticket = require('../../models/common/Ticket');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

/**
 * POST /api/internal/sync/tickets
 *
 * Body : { sourceAppId, sourceCategoryId, title, date, closingAt }
 *
 * Wintips cherche dans ses categories celle qui declare ce
 * `{ sourceAppId, sourceCategoryId }` en externalSources. Si trouve :
 * cree un ticket dans cette categorie. Si rien : ignore (200 + flag).
 */
exports.createTicket = async (req, res) => {
  try {
    const { sourceAppId, sourceCategoryId, title, date, closingAt } = req.body;
    if (!sourceAppId || !sourceCategoryId || !title || !date) {
      return formatError(res, 'sourceAppId, sourceCategoryId, title, date sont requis', 400);
    }

    // Resolution : trouver la categorie wintips qui declare cette source
    const targetCat = await Category.findOne({
      isActive: true,
      'externalSources': {
        $elemMatch: {
          system: 'bigwin',
          appId: sourceAppId,
          categoryId: String(sourceCategoryId),
        },
      },
    }).lean();

    if (!targetCat) {
      // Aucun mapping configure cote wintips -> on ignore poliment.
      // bigwin marquera ce ticket comme deja synchro pour eviter de retenter.
      return formatSuccess(res, {
        data: { ignored: true, reason: 'no externalSources match' },
        message: 'No wintips category subscribes to this source',
      });
    }

    const ticket = await ticketService.createTicket({
      title,
      date: new Date(date),
      category: targetCat._id,
      closingAt: closingAt ? new Date(closingAt) : new Date(date),
    });
    res.status(201);
    return formatSuccess(res, { data: ticket, message: 'Ticket cloned in wintips' });
  } catch (err) {
    return formatError(res, err.message, 500);
  }
};

/**
 * POST /api/internal/sync/tickets/:id/predictions
 *
 * Body : { predictions: [{ matchData, event, odds, sport }] }
 */
exports.bulkPredictions = async (req, res) => {
  try {
    const { id } = req.params;
    const { predictions } = req.body;
    if (!Array.isArray(predictions) || predictions.length === 0) {
      return formatError(res, 'predictions doit etre un array non vide', 400);
    }
    const exists = await Ticket.exists({ _id: id });
    if (!exists) return formatError(res, 'Ticket wintips introuvable', 404);

    const created = await predictionService.addPredictionsToTicket(id, predictions);
    res.status(201);
    return formatSuccess(res, { data: created, message: 'Predictions added' });
  } catch (err) {
    return formatError(res, err.message, 500);
  }
};

/**
 * PUT /api/internal/sync/tickets/:id/publish
 *
 * Toggle isVisible=true -> declenche la notif push wintips
 * via le hook post('findOneAndUpdate') du Ticket model.
 */
exports.publishTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await ticketService.updateTicket(id, { isVisible: true });
    if (!ticket) return formatError(res, 'Ticket introuvable', 404);
    return formatSuccess(res, { data: ticket, message: 'Ticket published' });
  } catch (err) {
    return formatError(res, err.message, 500);
  }
};
