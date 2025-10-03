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
module.exports = router;