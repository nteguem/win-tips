/**
 * Routes Admin pour gestion des tickets
 */
const express = require('express');
const ticketController = require('../../controllers/common/ticketController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

// Protection admin sur toutes les routes
router.use(adminAuth.protect);

// CRUD complet pour admin
router.route('/')
  .get(ticketController.getTickets)
  .post(ticketController.createTicket);

router.route('/:id')
  .get(ticketController.getTicketById)
  .put(ticketController.updateTicket)
  .delete(ticketController.deleteTicket);

// Correction manuelle d'un ticket (corrige les pronostics + recalcule le résultat)
router.post('/:id/correct', ticketController.correctTicket);

module.exports = router;