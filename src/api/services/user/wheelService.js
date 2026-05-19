// src/api/services/user/wheelService.js
//
// Cœur métier de la "Roue de la Chance" — V2 avec système de TICKETS.
//
// Architecture :
//   - L'user a un solde de tours (ticketsBalance) géré dans WheelUserStats.
//   - Pour gagner des tours, il passe par wheelTicketService (qui consomme
//     des pubs via le pipeline SSV existant).
//   - Pour tourner la roue, il dépense 1 tour : c'est synchrone côté serveur
//     (pas de pubs à ce moment-là). Le mobile fait converger son animation
//     vers le segment du lot retourné.
//
// Le tirage reste pondéré + capé exactement comme avant. Idempotence du spin
// via un `clientRequestId` optionnel (le mobile peut retry sans consommer
// 2 tickets en cas de timeout réseau).

const crypto = require('crypto');
const WheelPrize = require('../../models/common/WheelPrize');
const WheelConfig = require('../../models/common/WheelConfig');
const WheelSpin = require('../../models/common/WheelSpin');
const WheelUserStats = require('../../models/common/WheelUserStats');
const Subscription = require('../../models/common/Subscription');
const walletService = require('../common/walletService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1); }

/**
 * Vérifie qu'un lot peut être tiré : enabled + tous les caps satisfaits.
 */
async function isPrizeAvailable(prize, userId) {
  if (!prize.enabled) return false;
  const c = prize.caps || {};
  if (c.globalDay != null) {
    const n = await WheelSpin.countDocuments({ prize: prize._id, createdAt: { $gte: startOfDay() } });
    if (n >= c.globalDay) return false;
  }
  if (c.globalMonth != null) {
    const n = await WheelSpin.countDocuments({ prize: prize._id, createdAt: { $gte: startOfMonth() } });
    if (n >= c.globalMonth) return false;
  }
  if (c.userDay != null) {
    const n = await WheelSpin.countDocuments({ user: userId, prize: prize._id, createdAt: { $gte: startOfDay() } });
    if (n >= c.userDay) return false;
  }
  if (c.userMonth != null) {
    const n = await WheelSpin.countDocuments({ user: userId, prize: prize._id, createdAt: { $gte: startOfMonth() } });
    if (n >= c.userMonth) return false;
  }
  if (c.userLifetime != null) {
    const n = await WheelSpin.countDocuments({ user: userId, prize: prize._id });
    if (n >= c.userLifetime) return false;
  }
  if (c.window && c.window.days && c.window.max != null) {
    const since = new Date(Date.now() - c.window.days * 86400000);
    const n = await WheelSpin.countDocuments({ prize: prize._id, createdAt: { $gte: since } });
    if (n >= c.window.max) return false;
  }
  return true;
}

/**
 * Tirage pondéré parmi les lots dispos, avec fallback isFallback.
 */
async function drawPrize(userId) {
  const all = await WheelPrize.find({ enabled: true });
  if (all.length === 0) {
    throw new AppError('Aucun lot configuré sur la roue.', 500, ErrorCodes.SERVICE_UNAVAILABLE);
  }
  const available = [];
  for (const p of all) {
    if (await isPrizeAvailable(p, userId)) available.push(p);
  }
  if (available.length === 0) {
    const fb = await WheelPrize.findOne({ isFallback: true, enabled: true });
    return fb || all[0];
  }
  const totalWeight = available.reduce((s, p) => s + Math.max(0, p.weight || 0), 0);
  if (totalWeight <= 0) {
    const fb = available.find(p => p.isFallback) || available[0];
    return fb;
  }
  let r = Math.random() * totalWeight;
  for (const p of available) {
    r -= Math.max(0, p.weight || 0);
    if (r <= 0) return p;
  }
  return available[available.length - 1];
}

/**
 * Spin synchrone : consomme 1 ticket, tire un lot, applique, crée WheelSpin.
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.currency - devise locale de l'user (XAF, CDF, etc.) — affecte le montant cash crédité
 * @param {string} opts.lang     - langue pour la sérialisation
 * @param {string} opts.clientRequestId - optionnel, idempotence côté mobile (retry safe)
 *
 * @returns spin formaté
 */
async function spin(userId, { currency = 'XAF', lang = 'fr', clientRequestId } = {}) {
  const cfg = await WheelConfig.getSingleton();
  if (!cfg.wheelEnabled) {
    throw new AppError('La roue est temporairement indisponible.', 503, ErrorCodes.SERVICE_UNAVAILABLE);
  }

  // Idempotence client : si un WheelSpin existe déjà pour ce clientRequestId,
  // on le retourne au lieu de consommer un nouveau ticket.
  if (clientRequestId) {
    const existing = await WheelSpin.findOne({ nonce: `cli-${clientRequestId}` }).populate('prize');
    if (existing) return formatSpin(existing, lang, currency);
  }

  const stats = await WheelUserStats.getOrCreate(userId);

  // Cooldown anti-bot (existant)
  if (stats.lastSpinAt && cfg.cooldownSec > 0) {
    const elapsed = (Date.now() - stats.lastSpinAt.getTime()) / 1000;
    if (elapsed < cfg.cooldownSec) {
      throw new AppError(
        `Patiente ${Math.ceil(cfg.cooldownSec - elapsed)}s avant de relancer.`,
        429, ErrorCodes.RATE_LIMIT_EXCEEDED
      );
    }
  }

  // Limite quotidienne (anti-farm)
  const todayCount = await WheelSpin.countDocuments({ user: userId, createdAt: { $gte: startOfDay() } });
  if (todayCount >= cfg.dailyMaxSpinsPerUser) {
    throw new AppError('Tu as atteint le maximum de tours pour aujourd\'hui.', 429, ErrorCodes.RATE_LIMIT_EXCEEDED);
  }

  // *** Consommation du ticket ***
  if ((stats.ticketsBalance || 0) < 1) {
    throw new AppError(
      'Tu n\'as plus de tours. Regarde des pubs pour en obtenir.',
      402,  // 402 Payment Required → sémantiquement parfait
      ErrorCodes.PAYMENT_REQUIRED
    );
  }
  // Décrémente AVANT le tirage (atomicité approximative — si erreur en aval,
  // l'user perd un ticket mais ne reçoit pas le prize : compensable manuellement).
  stats.ticketsBalance = Math.max(0, stats.ticketsBalance - 1);

  const prize = await drawPrize(userId);

  // Snapshot complet du prize (incluant amounts multi-devises pour audit)
  const snapshot = {
    name: prize.name,
    type: prize.type,
    cash: prize.cash ? {
      amount: prize.getCashAmountFor(currency, cfg.defaultCurrency),
      currency: prize.getCashCurrency(currency, cfg.defaultCurrency)
    } : null,
    physical: prize.physical,
    subscription: prize.subscription,
    freeSpin: prize.freeSpin
  };

  let status = 'won';
  let walletTxId = null;
  let subId = null;

  try {
    if (prize.type === 'cash') {
      const amount = prize.getCashAmountFor(currency, cfg.defaultCurrency) || 0;
      const cashCur = prize.getCashCurrency(currency, cfg.defaultCurrency);
      if (amount > 0) {
        const { transaction } = await walletService.credit({
          userId, amount, currency: cashCur,
          source: { kind: 'wheel_spin', ref: null },
          description: `Gain roue: ${prize.name?.fr || 'cash'}`
        });
        walletTxId = transaction._id;
      }
      status = 'claimed_auto';
    } else if (prize.type === 'free_spin') {
      // Un free_spin gagné = +N tickets directement
      const n = prize.freeSpin?.count || 1;
      stats.ticketsBalance += n;
      stats.totalTicketsEarned = (stats.totalTicketsEarned || 0) + n;
      status = 'claimed_auto';
    } else if (prize.type === 'subscription' && prize.subscription?.packageId) {
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + (prize.subscription.durationHours || 24) * 3600 * 1000);
      const sub = await Subscription.create({
        user: userId,
        package: prize.subscription.packageId,
        startDate, endDate,
        pricing: { amount: 0, currency: 'XAF' },
        status: 'active',
        paymentProvider: 'ADS',
        paymentReference: `wheel:${userId}:${Date.now()}`
      });
      subId = sub._id;
      status = 'claimed_auto';
    } else if (prize.type === 'physical') {
      status = 'pending_delivery';
    } else {
      status = 'claimed_auto';
    }
  } catch (e) {
    console.error('[wheelService.spin] Apply prize failed:', e.message);
  }

  // Génère un nonce unique pour ce spin (utilisé pour l'index unique + idempotence client)
  const spinNonce = clientRequestId
    ? `cli-${clientRequestId}`
    : `sync-${crypto.randomBytes(12).toString('hex')}-${Date.now()}`;

  // Création du WheelSpin
  let spin;
  try {
    spin = await WheelSpin.create({
      user: userId,
      prize: prize._id,
      prizeSnapshot: snapshot,
      unlockId: null,           // pas d'unlock dans le nouveau flow synchrone
      nonce: spinNonce,
      adsRequired: 0,           // 0 — pas de pubs au moment du spin
      wasFreeSpin: false,
      status,
      walletTransaction: walletTxId,
      subscriptionCreated: subId
    });
  } catch (e) {
    if (e.code === 11000) {
      // Race sur nonce (clientRequestId reused) → on retourne l'existant
      const existing = await WheelSpin.findOne({ nonce: spinNonce }).populate('prize');
      if (existing) {
        // Restaure le ticket consommé (rollback)
        stats.ticketsBalance += 1;
        await stats.save();
        return formatSpin(existing, lang, currency);
      }
    }
    // Restaure le ticket en cas d'erreur fatale
    stats.ticketsBalance += 1;
    await stats.save();
    throw e;
  }

  // Stats user
  stats.lastSpinAt = new Date();
  stats.totalSpins = (stats.totalSpins || 0) + 1;
  await stats.save();

  await spin.populate('prize');
  return formatSpin(spin, lang, currency);
}

/**
 * Formatte un WheelSpin pour le client.
 */
function formatSpin(spin, lang = 'fr', currency = 'XAF') {
  const p = spin.prize || {};
  const snap = spin.prizeSnapshot || {};
  const name = snap.name || p.name || {};
  return {
    _id: spin._id,
    status: spin.status,
    wasFreeSpin: spin.wasFreeSpin,
    createdAt: spin.createdAt,
    prize: {
      _id: p._id || null,
      name: name[lang] || name.fr || '',
      type: snap.type || p.type,
      color: p.color || '#FFD700',
      icon: p.icon || null,
      order: p.order ?? null,
      cash: snap.cash || p.cash || null,
      physical: snap.physical || p.physical || null,
      subscription: snap.subscription || p.subscription || null,
      freeSpin: snap.freeSpin || p.freeSpin || null
    }
  };
}

/**
 * Config publique pour le client — adapte les montants cash à la devise de l'user.
 */
async function getPublicConfig(lang = 'fr', currency = 'XAF') {
  const cfg = await WheelConfig.getSingleton();
  const prizes = await WheelPrize.find({ enabled: true }).sort({ order: 1, createdAt: 1 });
  return {
    wheelEnabled: cfg.wheelEnabled,
    adsPerSpin: cfg.adsPerSpin,             // rétro-compat
    cooldownSec: cfg.cooldownSec,
    dailyMaxSpinsPerUser: cfg.dailyMaxSpinsPerUser,
    defaultCurrency: cfg.defaultCurrency,
    prizes: prizes.map(p => p.toPublicJSON(lang, currency))
  };
}

/**
 * Historique des spins d'un user (paginé, descendant).
 */
async function getHistory(userId, { limit = 20, skip = 0, lang = 'fr', currency = 'XAF' } = {}) {
  const spins = await WheelSpin.find({ user: userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Math.min(limit, 100))
    .populate('prize');
  return spins.map(s => formatSpin(s, lang, currency));
}

/**
 * Récupère le solde de tickets + stats user (vue publique pour le mobile).
 */
async function getUserStats(userId) {
  const stats = await WheelUserStats.getOrCreate(userId);
  return {
    ticketsBalance: stats.ticketsBalance || 0,
    totalTicketsEarned: stats.totalTicketsEarned || 0,
    totalSpins: stats.totalSpins || 0,
    lastSpinAt: stats.lastSpinAt
  };
}

module.exports = {
  spin,
  drawPrize,
  getPublicConfig,
  getHistory,
  getUserStats
};
