const Prediction = require('../../models/common/Prediction');

class PredictionService {
  
  // Créer une nouvelle prédiction
  async createPrediction(data) {
    const prediction = new Prediction(data);
  if (prediction.ticket) {
    const ticketService = require('./ticketService'); 
    await ticketService.updateClosingTime(prediction.ticket);
  }
    return await prediction.save();
  }

  // Récupérer toutes les prédictions avec pagination
  async getPredictions({ offset = 0, limit = 10, ticket = null, sport = null, status = null }) {
    const filter = {};
    
    if (ticket) {
      filter.ticket = ticket;
    }

    if (sport) {
      filter.sport = sport;
    }

    if (status) {
      filter.status = status;
    }

    const predictions = await Prediction.find(filter)
      .populate('ticket')
      .skip(offset)
      .limit(limit)
      .sort({ createdAt: -1 });

    const total = await Prediction.countDocuments(filter);

    return {
      data: predictions,
      pagination: {
        offset,
        limit,
        total,
        hasNext: (offset + limit) < total
      }
    };
  }

  // Récupérer une prédiction par ID
  async getPredictionById(id) {
    return await Prediction.findById(id).populate('ticket');
  }

  // Récupérer les prédictions d'un ticket
  async getPredictionsByTicket(ticketId) {
    return await Prediction.find({ ticket: ticketId });
  }

  // Mettre à jour une prédiction
  async updatePrediction(id, data) {
    return await Prediction.findByIdAndUpdate(id, data, { new: true });
  }

  // Supprimer une prédiction
  async deletePrediction(id) {
    return await Prediction.findByIdAndDelete(id);
  }

  // Mettre à jour le statut d'une prédiction
  async updatePredictionStatus(id, status) {
    return await this.updatePrediction(id, { status });
  }

  // Vérifier si une prédiction existe
  async predictionExists(id) {
    const prediction = await Prediction.findById(id);
    return !!prediction;
  }

  // Récupérer les prédictions par statut
  async getPredictionsByStatus(status, { offset = 0, limit = 10 }) {
    return await this.getPredictions({ offset, limit, status });
  }

  // Récupérer les prédictions par sport
  async getPredictionsBySport(sport, { offset = 0, limit = 10 }) {
    return await this.getPredictions({ offset, limit, sport });
  }

  // Ajouter plusieurs prédictions à un ticket
  async addPredictionsToTicket(ticketId, predictionsData) {
    const predictions = [];
    
    for (const data of predictionsData) {
      const predictionData = { ...data, ticket: ticketId };
      const prediction = await this.createPrediction(predictionData);
      predictions.push(prediction);
    }
    
    return predictions;
  }
}

module.exports = new PredictionService();