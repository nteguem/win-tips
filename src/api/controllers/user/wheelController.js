// src/api/controllers/user/wheelController.js
//
// Endpoints user pour la "Roue de la Chance" — V2 avec système de tickets.

const wheelService = require('../../services/user/wheelService');
const wheelTicketService = require('../../services/user/wheelTicketService');
const walletService = require('../../services/common/walletService');
const catchAsync = require('../../../utils/catchAsync');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

function getLang(req) {
  const l = (req.query?.lang || req.headers?.['accept-language'] || 'fr').toString().toLowerCase();
  return l.startsWith('en') ? 'en' : 'fr';
}
function getCurrency(req) {
  return (req.query?.currency || 'XAF').toString().toUpperCase();
}

// ====== CONFIG + ÉTAT USER ================================================

/**
 * GET /api/user/wheel/config
 *   Config + lots adaptés à la devise. Public (pas d'auth).
 */
exports.getConfig = catchAsync(async (req, res) => {
  const data = await wheelService.getPublicConfig(getLang(req), getCurrency(req));
  res.status(200).json({ success: true, data });
});

/**
 * GET /api/user/wheel/stats
 *   Solde de tickets + stats user. Auth requise.
 */
exports.getStats = catchAsync(async (req, res) => {
  const data = await wheelService.getUserStats(req.user._id);
  res.status(200).json({ success: true, data });
});

// ====== SPIN (consomme 1 ticket) ==========================================

/**
 * POST /api/user/wheel/spin
 *   Body: { clientRequestId? }
 *   Consomme 1 ticket et tire un lot — synchrone.
 *   - 402 si ticketsBalance < 1 (→ envoyer user vers l'écran "Obtenir des tours")
 *   - 429 cooldown / limite quotidienne
 *   - 503 roue désactivée
 *
 *   Retour : { spin: { _id, prize: {...} } }
 */
exports.spin = catchAsync(async (req, res) => {
  const spin = await wheelService.spin(req.user._id, {
    currency: getCurrency(req),
    lang: getLang(req),
    clientRequestId: req.body?.clientRequestId
  });
  res.status(200).json({ success: true, data: { spin } });
});

// ====== TICKETS (déblocage via pubs) ======================================

/**
 * GET /api/user/wheel/ticket-packs
 *   Liste les packs configurés par l'admin.
 */
exports.listTicketPacks = catchAsync(async (req, res) => {
  const data = await wheelTicketService.listPacks(getLang(req));
  res.status(200).json({ success: true, data });
});

/**
 * POST /api/user/wheel/tickets/unlock/start
 *   Body: { packIndex }
 *   Démarre une session de déblocage de tickets via pubs.
 *   Retour : { nonce, adsRequired, ticketsToCredit, packIndex, packLabel }
 */
exports.startTicketsUnlock = catchAsync(async (req, res, next) => {
  const packIndex = req.body?.packIndex;
  if (packIndex === undefined || packIndex === null) {
    return next(new AppError('packIndex requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  const data = await wheelTicketService.startUnlock(req.user._id, packIndex);
  res.status(200).json({ success: true, data });
});

/**
 * GET /api/user/wheel/tickets/unlock/state
 *   Polling. Quand seuil atteint → crédite ticketsBalance.
 *   Retour : { hasActiveUnlock, adsRequired, adsWatched, completed, nonce,
 *              ticketsBalance, justCredited }
 */
exports.getTicketsUnlockState = catchAsync(async (req, res) => {
  const data = await wheelTicketService.getUnlockState(req.user._id);
  res.status(200).json({ success: true, data });
});

// ====== HISTORIQUE ========================================================

exports.getHistory = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const skip = parseInt(req.query.skip, 10) || 0;
  const data = await wheelService.getHistory(req.user._id, {
    limit, skip,
    lang: getLang(req),
    currency: getCurrency(req)
  });
  res.status(200).json({ success: true, data });
});

// ====== WALLET (inchangé) =================================================

exports.getWallet = catchAsync(async (req, res) => {
  const data = await walletService.getWalletView(req.user._id);
  res.status(200).json({ success: true, data });
});

exports.getWalletTransactions = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const skip = parseInt(req.query.skip, 10) || 0;
  const txs = await walletService.listTransactions(req.user._id, { limit, skip });
  res.status(200).json({ success: true, data: txs });
});

exports.requestWithdrawal = catchAsync(async (req, res) => {
  const { amount, currency = 'XAF', paymentMethod, paymentDetails } = req.body;
  const description = paymentMethod
    ? `Retrait via ${paymentMethod}${paymentDetails ? ` — ${paymentDetails}` : ''}`
    : 'Demande de retrait';
  const { transaction } = await walletService.requestWithdrawal({
    userId: req.user._id,
    amount: Number(amount),
    currency,
    description
  });
  res.status(201).json({ success: true, data: transaction });
});
