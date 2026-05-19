// src/api/controllers/user/wheelController.js
//
// Endpoints user pour la "Roue de la Chance". Authentification user requise
// pour toutes les routes sauf GET /config (lecture publique).

const wheelService = require('../../services/user/wheelService');
const walletService = require('../../services/common/walletService');
const catchAsync = require('../../../utils/catchAsync');

function getLang(req) {
  const l = (req.query?.lang || req.headers?.['accept-language'] || 'fr').toString().toLowerCase();
  return l.startsWith('en') ? 'en' : 'fr';
}

/**
 * GET /api/user/wheel/config
 *   Renvoie la config publique de la roue + liste ordonnée des lots.
 *   Accessible sans auth (utile pour pré-charger l'écran).
 */
exports.getConfig = catchAsync(async (req, res) => {
  const data = await wheelService.getPublicConfig(getLang(req));
  res.status(200).json({ success: true, data });
});

/**
 * POST /api/user/wheel/spin/start
 *   Démarre un tour : crée le UserAccessUnlock 'wheel_spin' + nonce.
 *   - 503 si roue désactivée
 *   - 429 si cooldown / limite quotidienne
 *
 *   Retour : { nonce, adsRequired, adsWatched, completed, wasFreeSpin,
 *              freeSpinsRemaining }
 */
exports.startSpin = catchAsync(async (req, res) => {
  const data = await wheelService.start(req.user._id);
  res.status(200).json({ success: true, data });
});

/**
 * GET /api/user/wheel/spin/state
 *   État courant + (si seuil de pubs atteint) tirage + distribution du lot.
 *   À polluer côté client après chaque pub vue.
 *
 *   Retour : { hasActiveSpin, adsRequired, adsWatched, completed, nonce,
 *              freeSpinsRemaining, spin? }
 */
exports.getSpinState = catchAsync(async (req, res) => {
  const data = await wheelService.getState(req.user._id, getLang(req));
  res.status(200).json({ success: true, data });
});

/**
 * GET /api/user/wheel/history?limit&skip
 *   Historique paginé des spins de l'user.
 */
exports.getHistory = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const skip = parseInt(req.query.skip, 10) || 0;
  const data = await wheelService.getHistory(req.user._id, {
    limit,
    skip,
    lang: getLang(req)
  });
  res.status(200).json({ success: true, data });
});

/**
 * GET /api/user/wheel/wallet
 *   Solde + totaux du wallet user.
 */
exports.getWallet = catchAsync(async (req, res) => {
  const data = await walletService.getWalletView(req.user._id);
  res.status(200).json({ success: true, data });
});

/**
 * GET /api/user/wheel/wallet/transactions
 *   Historique des transactions wallet.
 */
exports.getWalletTransactions = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const skip = parseInt(req.query.skip, 10) || 0;
  const txs = await walletService.listTransactions(req.user._id, { limit, skip });
  res.status(200).json({ success: true, data: txs });
});

/**
 * POST /api/user/wheel/wallet/withdraw
 *   { amount, currency, paymentMethod?, paymentDetails? }
 *   V1 : crée une TX pending qu'un admin valide manuellement.
 */
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
