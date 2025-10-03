// src/api/controllers/common/notificationController.js
const notificationService = require('../../services/common/notificationService');
const catchAsync = require('../../../utils/catchAsync');
const AppError = require('../../../utils/AppError');

/**
 * Endpoint de base : Envoyer à des playerIds
 */
const send = catchAsync(async (req, res) => {
  const { playerIds, notification } = req.body;

  if (!playerIds || !notification?.contents) {
    throw new AppError('playerIds et notification.contents requis', 400);
  }

  const result = await notificationService.send(playerIds, notification);

  res.status(200).json({
    success: true,
    data: result
  });
});

/**
 * Endpoint de base : Broadcast
 */
const broadcast = catchAsync(async (req, res) => {
  const { notification } = req.body;

  if (!notification?.contents) {
    throw new AppError('notification.contents requis', 400);
  }

  const result = await notificationService.broadcast(notification);

  res.status(200).json({
    success: true,
    data: result
  });
});

/**
 * Endpoint de base : Envoyer avec filtres
 */
const sendWithFilters = catchAsync(async (req, res) => {
  const { filters, notification } = req.body;

  if (!filters || !notification?.contents) {
    throw new AppError('filters et notification.contents requis', 400);
  }

  const result = await notificationService.sendWithFilters(filters, notification);

  res.status(200).json({
    success: true,
    data: result
  });
});

/**
 * NOUVEAU: Vérifier si des player IDs sont valides
 */
const checkPlayers = catchAsync(async (req, res) => {
  const { playerIds } = req.body;

  if (!playerIds) {
    throw new AppError('playerIds requis', 400);
  }

  const result = await notificationService.checkPlayerIds(playerIds);

  res.status(200).json({
    success: true,
    data: result
  });
});

/**
 * NOUVEAU: Récupérer la liste des utilisateurs actifs
 */
const getActivePlayers = catchAsync(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  const result = await notificationService.getActivePlayers(parseInt(limit), parseInt(offset));

  res.status(200).json({
    success: true,
    data: result,
    count: result.length
  });
});

module.exports = {
  send,
  broadcast,
  sendWithFilters,
  checkPlayers,      // NOUVEAU
  getActivePlayers   // NOUVEAU
};