// controllers/predictionController.js
const predictionService = require('../../services/common/predictionService');
const ticketService = require('../../services/common/ticketService');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

class PredictionController {

  // GET /predictions - Récupérer toutes les prédictions
  // Query params: ?offset=0&limit=10&ticket=ticketId&sport=football&status=pending
  async getPredictions(req, res) {
    try {
      const { offset = 0, limit = 10, ticket, sport, status } = req.query;
      
      const result = await predictionService.getPredictions({
        offset: parseInt(offset),
        limit: parseInt(limit),
        ticket,
        sport,
        status
      });

      formatSuccess(res, {
        data: result.data,
        pagination: result.pagination,
        message: 'Predictions retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // GET /predictions/:id - Récupérer une prédiction par ID
  async getPredictionById(req, res) {
    try {
      const { id } = req.params;
      const prediction = await predictionService.getPredictionById(id);

      if (!prediction) {
        return formatError(res, 'Prediction not found', 404);
      }

      formatSuccess(res, {
        data: prediction,
        message: 'Prediction retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // POST /predictions - Créer une nouvelle prédiction
  // Payload: { ticket: "ticketId", matchData: {...}, event: {...}, odds: 2.50, sport: "football" }

async createPrediction(req, res) {
  try {
    const { ticket, matchData, event, odds, sport } = req.body;

    if (!ticket || !matchData || !event || !odds || !sport) {
      return formatError(res, {
        message: 'Ticket, matchData, event, odds and sport are required',
        statusCode: 400,
        errors: {
          ticket: !!ticket,
          matchData: !!matchData,
          event: !!event,
          odds: !!odds,
          sport: !!sport
        }
      });
    }

    const ticketExists = await ticketService.ticketExists(ticket);
    if (!ticketExists) {
      return formatError(res, {
        message: 'Ticket not found',
        statusCode: 404
      });
    }

    const predictionData = {
      ticket,
      matchData,
      event,
      odds: parseFloat(odds),
      sport
    };

    const prediction = await predictionService.createPrediction(predictionData);

    return formatSuccess(res, {
      data: prediction,
      message: 'Prediction created successfully',
      statusCode: 201
    });

  } catch (error) {
    return formatError(res, {
      message: error.message,
      statusCode: 500,
      stack: error.stack
    });
  }
}
  // PUT /predictions/:id - Mettre à jour une prédiction
  // Payloads possibles:
  // { odds: 3.50 } - Modifier la cote
  // { status: "won" } - Marquer comme gagnée
  // { status: "lost" } - Marquer comme perdue
  // { status: "void" } - Annuler la prédiction
  // { matchData: {...} } - Mettre à jour les données du match
  async updatePrediction(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Convertir odds en nombre si présent
      if (updates.odds) {
        updates.odds = parseFloat(updates.odds);
      }

      const prediction = await predictionService.updatePrediction(id, updates);

      if (!prediction) {
        return formatError(res, 'Prediction not found', 404);
      }

      formatSuccess(res, {
        data: prediction,
        message: 'Prediction updated successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // DELETE /predictions/:id - Supprimer une prédiction
  async deletePrediction(req, res) {
    try {
      const { id } = req.params;
      const result = await predictionService.deletePrediction(id);

      if (!result) {
        return formatError(res, 'Prediction not found', 404);
      }

      formatSuccess(res, {
        data: null,
        message: 'Prediction deleted successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // POST /predictions/bulk - Ajouter plusieurs prédictions à un ticket
  // Payload: { ticketId: "ticketId", predictions: [{ matchData: {...}, event: {...}, odds: 2.50, sport: "football" }] }
  async addPredictionsToTicket(req, res) {
    try {
      const { ticketId, predictions } = req.body;

      if (!ticketId || !predictions || !Array.isArray(predictions)) {
        return formatError(res, 'TicketId and predictions array are required', 400);
      }

      // Vérifier que le ticket existe
      const ticketExists = await ticketService.ticketExists(ticketId);
      if (!ticketExists) {
        return formatError(res, 'Ticket not found', 404);
      }

      const createdPredictions = await predictionService.addPredictionsToTicket(ticketId, predictions);
      
      res.status(201);
      formatSuccess(res, {
        data: createdPredictions,
        message: 'Predictions added successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }
}

module.exports = new PredictionController();