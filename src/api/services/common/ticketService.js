const Ticket = require('../../models/common/Ticket');
const Prediction = require("../../models/common/Prediction")
const predictionService = require('./predictionService');

class TicketService {
  
  // Créer un nouveau ticket
  async createTicket(data) {
    const ticket = new Ticket(data);
    return await ticket.save();
  }

  // Récupérer tous les tickets avec pagination et leurs prédictions
async getTickets({ offset = 0, limit = 10, category = null, date = null, isVisible = null }) {
  const filter = {};
        
  // Seulement ajouter isVisible au filtre s'il est explicitement défini
  if (isVisible !== null) {
    filter.isVisible = isVisible;
  }
  
  if (category) {
    filter.category = category;
  }

  if (date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
            
    filter.date = {
      $gte: startOfDay,
      $lte: endOfDay
    };
  }

  const tickets = await Ticket.find(filter)
    .populate('category')
    .skip(offset)
    .limit(limit)
    .sort({ date: -1 });

  // Récupérer les prédictions pour chaque ticket
  const ticketsWithPredictions = await Promise.all(
    tickets.map(async (ticket) => {
      const predictions = await predictionService.getPredictionsByTicket(ticket._id);
      return {
        ...ticket.toObject(),
        predictions
      };
    })
  );

  const total = await Ticket.countDocuments(filter);

  return {
    data: ticketsWithPredictions,
    pagination: {
      offset,
      limit,
      total,
      hasNext: (offset + limit) < total
    }
  };
}

  // Récupérer un ticket par ID avec ses prédictions
  async getTicketById(id) {
    const ticket = await Ticket.findById(id).populate('category');
    if (!ticket) return null;

    const predictions = await predictionService.getPredictionsByTicket(id);
    
    return {
      ...ticket.toObject(),
      predictions
    };
  }

  // Mettre à jour un ticket
  async updateTicket(id, data) {
    return await Ticket.findByIdAndUpdate(id, data, { new: true });
  }

  // NOUVEAU : Supprimer un ticket et toutes ses prédictions
  async deleteTicket(id) {
    // Vérifier que le ticket existe
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return null;
    }

    // Supprimer toutes les prédictions associées au ticket
    await Prediction.deleteMany({ ticket: id });

    // Supprimer le ticket
    await Ticket.findByIdAndDelete(id);

    return { 
      deletedTicket: ticket,
      message: 'Ticket and associated predictions deleted successfully'
    };
  }

  // Calculer et mettre à jour le closingAt d'un ticket
  async updateClosingTime(ticketId) {
    const predictions = await predictionService.getPredictionsByTicket(ticketId);
    
    if (predictions.length === 0) {
      return null;
    }

    // Trouver le match le plus tard
    const latestMatchDate = predictions.reduce((latest, pred) => {
      const matchDate = new Date(pred.matchData.date);
      return matchDate > latest ? matchDate : latest;
    }, new Date(0));

    // Ajouter 3 heures
    const closingAt = new Date(latestMatchDate.getTime() + (3 * 60 * 60 * 1000));

    return await this.updateTicket(ticketId, { closingAt });
  }

  // Rendre un ticket visible
  async publishTicket(id) {
    return await this.updateTicket(id, { isVisible: true });
  }

  // Cacher un ticket
  async hideTicket(id) {
    return await this.updateTicket(id, { isVisible: false });
  }

  // Fermer un ticket
  async closeTicket(id) {
    return await this.updateTicket(id, { status: 'closed' });
  }

  // Vérifier si un ticket existe
  async ticketExists(id) {
    const ticket = await Ticket.findById(id);
    return !!ticket;
  }

  
  /**
   * NOUVELLE MÉTHODE OPTIMISÉE
   * Récupère toutes les prédictions pour plusieurs tickets en une seule requête
   * @param {Array} ticketIds - Array d'IDs de tickets
   * @returns {Array} Toutes les prédictions pour ces tickets
   */
  async getPredictionsByTicketIds(ticketIds) {
    try {
      // Une seule requête pour récupérer toutes les prédictions
      const predictions = await Prediction.find({
        ticket: { $in: ticketIds }
      })
      .populate('event')
      .populate('matchData')
      .lean(); // Pour de meilleures performances

      return predictions;
    } catch (error) {
      console.error('Erreur lors de la récupération des prédictions:', error);
      return [];
    }
  }

  // Version alternative avec aggregation pipeline pour encore plus de performance
  async getPredictionsByTicketIdsOptimized(ticketIds) {
    try {
      const predictions = await Prediction.aggregate([
        {
          $match: {
            ticket: { $in: ticketIds.map(id => mongoose.Types.ObjectId(id)) }
          }
        },
        {
          $lookup: {
            from: 'events',
            localField: 'event',
            foreignField: '_id',
            as: 'event'
          }
        },
        {
          $unwind: {
            path: '$event',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: 'matches',
            localField: 'matchData',
            foreignField: '_id',
            as: 'matchData'
          }
        },
        {
          $unwind: {
            path: '$matchData',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          // Projeter seulement les champs nécessaires
          $project: {
            _id: 1,
            ticket: 1,
            odds: 1,
            status: 1,
            sport: 1,
            'event._id': 1,
            'event.label': 1,
            'event.description': 1,
            'event.category': 1,
            'matchData._id': 1,
            'matchData.date': 1,
            'matchData.status': 1,
            'matchData.league': 1,
            'matchData.teams': 1,
            'matchData.venue': 1,
            'matchData.score': 1
          }
        }
      ]);

      return predictions;
    } catch (error) {
      console.error('Erreur lors de la récupération des prédictions:', error);
      return [];
    }
  }

}

module.exports = new TicketService();