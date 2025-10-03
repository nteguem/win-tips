// src/api/routes/common/notificationRoutes.js
const express = require('express');
const notificationController = require('../../controllers/common/notificationController');

const router = express.Router();

/**
 * @route POST /api/notifications/send
 * @desc Envoyer une notification à des playerIds spécifiques
 * @body { playerIds: string[], notification: { contents: object, headings?: object, data?: object, options?: object } }
 * @access Private (Admin/System)
 */
router.post('/send', notificationController.send);

/**
 * @route POST /api/notifications/broadcast
 * @desc Envoyer une notification à tous les utilisateurs
 * @body { notification: { contents: object, headings?: object, data?: object, options?: object } }
 * @access Private (Admin/System)
 */
router.post('/broadcast', notificationController.broadcast);

/**
 * @route POST /api/notifications/send-with-filters
 * @desc Envoyer une notification avec des filtres OneSignal
 * @body { filters: array, notification: { contents: object, headings?: object, data?: object, options?: object } }
 * @access Private (Admin/System)
 */
router.post('/send-with-filters', notificationController.sendWithFilters);

/**
 * @route POST /api/notifications/check-players
 * @desc Vérifier si des player IDs sont valides et actifs
 * @body { playerIds: string[] }
 * @access Private (Admin/System)
 */
router.post('/check-players', notificationController.checkPlayers);

/**
 * @route GET /api/notifications/active-players
 * @desc Récupérer la liste des utilisateurs actifs
 * @query { limit?: number, offset?: number }
 * @access Private (Admin/System)
 */
router.get('/active-players', notificationController.getActivePlayers);

module.exports = router;