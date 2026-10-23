// src/api/controllers/user/packageAdUnlockController.js
//
// Endpoints user pour le déblocage de Packages par visionnage de pubs
// récompensées (paymentMode='ads'). Authentification user requise.

const packageAdUnlockService = require('../../services/user/packageAdUnlockService');
const catchAsync = require('../../../utils/catchAsync');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

/**
 * POST /api/user/subscriptions/ad-pack/:packageId/start
 *
 * Démarre (ou rafraîchit) une session de déblocage du package par pubs.
 * Renvoie un `nonce` à passer dans le `customData` des pubs récompensées.
 *
 *   - 409 si l'user a déjà un abonnement actif sur ce pack
 *   - 400 si le pack n'est pas en paymentMode='ads'
 *   - 404 si pack introuvable ou inactif
 */
exports.startAdUnlock = catchAsync(async (req, res, next) => {
  const { packageId } = req.params;
  if (!packageId) {
    return next(new AppError('packageId requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  const result = await packageAdUnlockService.start(req.user._id, packageId);
  res.status(200).json({ success: true, data: result });
});

/**
 * GET /api/user/subscriptions/ad-pack/:packageId/state
 *
 * État courant de la session ad-unlock + Subscription créée si éligible.
 * Idempotent : appelle ensureSubscription() si seuil atteint.
 *
 *   { packageId, paymentMode, adsRequired, adsWatched, completed, eligible,
 *     percentage, nonce, subscriptionCreated, subscription? }
 */
exports.getState = catchAsync(async (req, res, next) => {
  const { packageId } = req.params;
  if (!packageId) {
    return next(new AppError('packageId requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  const result = await packageAdUnlockService.getProgress(req.user._id, packageId);
  res.status(200).json({ success: true, data: result });
});
