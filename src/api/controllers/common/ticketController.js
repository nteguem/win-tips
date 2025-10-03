// controllers/ticketController.js
const ticketService = require('../../services/common/ticketService');
const categoryService = require('../../services/common/categoryService');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

class TicketController {

  // GET /tickets - Récupérer tous les tickets
  async getTickets(req, res) {
    try {
      const { offset = 0, limit = 10, category, date, isVisible } = req.query;
      
      const result = await ticketService.getTickets({
        offset: parseInt(offset),
        limit: parseInt(limit),
        category,
        date: date ? new Date(date) : null,
        isVisible: isVisible !== undefined ? isVisible === 'true' : null // null = pas de filtre
      });

      formatSuccess(res, {
        data: result.data,
        pagination: result.pagination,
        message: 'Tickets retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // GET /tickets/:id - Récupérer un ticket par ID
  async getTicketById(req, res) {
    try {
      const { id } = req.params;
      const ticket = await ticketService.getTicketById(id);

      if (!ticket) {
        return formatError(res, 'Ticket not found', 404);
      }

      formatSuccess(res, {
        data: ticket,
        message: 'Ticket retrieved successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // POST /tickets - Créer un nouveau ticket
  async createTicket(req, res) {
    try {
      const { title, date, category, closingAt } = req.body;

      if (!title || !date || !category) {
        return formatError(res, 'Title, date and category are required', 400);
      }

      // Vérifier que la catégorie existe
      const categoryExists = await categoryService.categoryExists(category);
      if (!categoryExists) {
        return formatError(res, 'Category not found', 404);
      }

      const ticketData = {
        title,
        date: new Date(date),
        category,
        closingAt: closingAt ? new Date(closingAt) : new Date(date)
      };

      const ticket = await ticketService.createTicket(ticketData);
      
      res.status(201);
      formatSuccess(res, {
        data: ticket,
        message: 'Ticket created successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // PUT /tickets/:id - Mettre à jour un ticket
  // Payloads possibles:
  // { title: "string", date: "2025-07-15", category: "categoryId" } - Modification basique
  // { isVisible: true } - Publier le ticket
  // { isVisible: false } - Cacher le ticket  
  // { status: "closed" } - Fermer le ticket
  // { closingAt: "2025-07-15T16:00:00Z" } - Modifier heure de fermeture
  async updateTicket(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Si on change la catégorie, vérifier qu'elle existe
      if (updates.category) {
        const categoryExists = await categoryService.categoryExists(updates.category);
        if (!categoryExists) {
          return formatError(res, 'Category not found', 404);
        }
      }

      // Convertir les dates si présentes
      if (updates.date) {
        updates.date = new Date(updates.date);
      }
      if (updates.closingAt) {
        updates.closingAt = new Date(updates.closingAt);
      }

      const ticket = await ticketService.updateTicket(id, updates);

      if (!ticket) {
        return formatError(res, 'Ticket not found', 404);
      }

      formatSuccess(res, {
        data: ticket,
        message: 'Ticket updated successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }

  // DELETE /tickets/:id - Supprimer un ticket et ses prédictions
  async deleteTicket(req, res) {
    try {
      const { id } = req.params;
      
      const result = await ticketService.deleteTicket(id);

      if (!result) {
        return formatError(res, 'Ticket not found', 404);
      }

      formatSuccess(res, {
        data: null,
        message: 'Ticket and associated predictions deleted successfully'
      });
    } catch (error) {
      formatError(res, error.message, 500);
    }
  }
}

module.exports = new TicketController();