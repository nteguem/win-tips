// controllers/ticketController.js
const ticketService = require('../../services/common/ticketService');
const categoryService = require('../../services/common/categoryService');
const correctAndNotifyService = require('../../services/admin/correctAndNotifyService');
const syncOutgoingService = require('../../services/admin/syncOutgoingService');
const Category = require('../../models/common/Category');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');

/**
 * Aplatit le nom/description bilingue ({fr,en}) de la catégorie peuplée d'un
 * ticket en chaîne simple : le backoffice et l'app attendent du texte, pas un
 * objet (sinon React plante en tentant d'afficher l'objet).
 */
function flattenTicketCategory(ticket, lang = 'fr') {
  if (!ticket) return ticket;
  const t = typeof ticket.toObject === 'function' ? ticket.toObject() : ticket;
  if (t.category && typeof t.category === 'object' && t.category.name !== undefined) {
    t.category = {
      ...t.category,
      name: Category.pickLang(t.category.name, lang),
      description: Category.pickLang(t.category.description, lang),
    };
  }
  return t;
}

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

      const lang = req.query.lang || 'fr';
      formatSuccess(res, {
        data: result.data.map((t) => flattenTicketCategory(t, lang)),
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
        data: flattenTicketCategory(ticket, req.query.lang || 'fr'),
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

      // Synchro sortante fire-and-forget : si la cible (WinTips) est
      // configurée via la variable d'env SYNC_TARGET_WINTIPS_URL, on lui
      // pousse l'info à chaque publication. WinTips décide lui-même si la
      // catégorie source est mappée chez lui.
      if (updates.isVisible === true) {
        syncOutgoingService.maybeSyncTicket(ticket).catch(() => {});
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

  // POST /tickets/:id/correct - Corriger un ticket (pronostics + résultat)
  async correctTicket(req, res) {
    try {
      const { id } = req.params;
      const result = await correctAndNotifyService.correctTicket(id);
      formatSuccess(res, {
        data: result,
        message: `Ticket corrigé — résultat : ${result.result}`
      });
    } catch (error) {
      formatError(res, error.message, error.statusCode || 500);
    }
  }
}

module.exports = new TicketController();