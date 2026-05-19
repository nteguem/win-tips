// src/api/services/user/wheelService.js
//
// Cœur métier de la "Roue de la Chance".
//
// Architecture du tour de roue :
//   1. start(userId)
//      - vérifie le cooldown, la limite quotidienne, l'état activé de la roue
//      - si l'user a un free_spin → crée un UserAccessUnlock 'wheel_spin'
//        directement `unlocked` (adsRequired=0) ; décrémente freeSpinsRemaining
//      - sinon → crée un UserAccessUnlock 'wheel_spin' `in_progress` avec
//        un nonce frais et adsRequired = config.adsPerSpin
//      - renvoie { nonce, adsRequired, wasFreeSpin }
//
//   2. Le client mobile lance les pubs récompensées en passant le nonce
//      dans le `customData` AdMob. Le pipeline SSV partagé
//      (accessGateService.recordVerifiedReward) incrémente `verifiedCount`
//      atomiquement (idempotent via transactionId).
//
//   3. getState(userId) — polling
//      - si l'unlock est `in_progress` → renvoie la progression (ads watched / required)
//      - si `unlocked` → appelle finalize() qui :
//          a) tire un lot pondéré (drawPrize) en respectant les caps
//          b) applique le lot (crédit wallet | crée Subscription | +free_spin | physical)
//          c) enregistre un WheelSpin (idempotent via unlockId unique)
//          d) RESET l'UserAccessUnlock pour permettre le prochain spin
//          e) renvoie le spin (avec prize) — le mobile fait converger
//             l'animation de la roue vers ce segment
//
// L'ordre "ads PUIS tirage" est anti-cheat : impossible de connaître le lot
// avant la fin des pubs. Le mobile reçoit le résultat juste avant
// l'animation finale.

const crypto = require('crypto');
const UserAccessUnlock = require('../../models/common/UserAccessUnlock');
const WheelPrize = require('../../models/common/WheelPrize');
const WheelConfig = require('../../models/common/WheelConfig');
const WheelSpin = require('../../models/common/WheelSpin');
const WheelUserStats = require('../../models/common/WheelUserStats');
const Subscription = require('../../models/common/Subscription');
const walletService = require('../common/walletService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

const RESOURCE_TYPE_WHEEL = 'wheel_spin';

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Vérifie qu'un lot peut être tiré : enabled + tous les caps satisfaits.
 * Les compteurs sont calculés à la volée par count() sur WheelSpin (indexé).
 */
async function isPrizeAvailable(prize, userId) {
  if (!prize.enabled) return false;
  const c = prize.caps || {};

  if (c.globalDay != null) {
    const n = await WheelSpin.countDocuments({
      prize: prize._id,
      createdAt: { $gte: startOfDay() }
    });
    if (n >= c.globalDay) return false;
  }
  if (c.globalMonth != null) {
    const n = await WheelSpin.countDocuments({
      prize: prize._id,
      createdAt: { $gte: startOfMonth() }
    });
    if (n >= c.globalMonth) return false;
  }
  if (c.userDay != null) {
    const n = await WheelSpin.countDocuments({
      user: userId,
      prize: prize._id,
      createdAt: { $gte: startOfDay() }
    });
    if (n >= c.userDay) return false;
  }
  if (c.userMonth != null) {
    const n = await WheelSpin.countDocuments({
      user: userId,
      prize: prize._id,
      createdAt: { $gte: startOfMonth() }
    });
    if (n >= c.userMonth) return false;
  }
  if (c.userLifetime != null) {
    const n = await WheelSpin.countDocuments({ user: userId, prize: prize._id });
    if (n >= c.userLifetime) return false;
  }
  if (c.window && c.window.days && c.window.max != null) {
    const since = new Date(Date.now() - c.window.days * 86400000);
    const n = await WheelSpin.countDocuments({
      prize: prize._id,
      createdAt: { $gte: since }
    });
    if (n >= c.window.max) return false;
  }
  return true;
}

/**
 * Tirage pondéré parmi les lots `enabled` ET non-capés. Si tous les lots
 * non-fallback sont indisponibles → fallback (lot marqué isFallback) → sinon
 * 1er lot enabled.
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
    // Tous weights à 0 : on tire le fallback si dispo, sinon uniforme
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
 * Démarre 1 tour. Si l'user a un free_spin accumulé → unlock immédiat.
 */
async function start(userId) {
  const cfg = await WheelConfig.getSingleton();
  if (!cfg.wheelEnabled) {
    throw new AppError(
      'La roue est temporairement indisponible.',
      503,
      ErrorCodes.SERVICE_UNAVAILABLE
    );
  }

  const stats = await WheelUserStats.getOrCreate(userId);

  // Cooldown
  if (stats.lastSpinAt && cfg.cooldownSec > 0) {
    const elapsedSec = (Date.now() - stats.lastSpinAt.getTime()) / 1000;
    if (elapsedSec < cfg.cooldownSec) {
      throw new AppError(
        `Patiente ${Math.ceil(cfg.cooldownSec - elapsedSec)}s avant de relancer.`,
        429,
        ErrorCodes.RATE_LIMIT_EXCEEDED
      );
    }
  }

  // Limite quotidienne
  const todayCount = await WheelSpin.countDocuments({
    user: userId,
    createdAt: { $gte: startOfDay() }
  });
  if (todayCount >= cfg.dailyMaxSpinsPerUser) {
    throw new AppError(
      'Tu as atteint le maximum de tours pour aujourd\'hui.',
      429,
      ErrorCodes.RATE_LIMIT_EXCEEDED
    );
  }

  // Free spin disponible ?
  const useFreeSpin = stats.freeSpinsRemaining > 0;
  const adsRequired = useFreeSpin ? 0 : cfg.adsPerSpin;

  // Trouver/réinitialiser l'unlock (singleton par user : resource = config._id)
  let doc = await UserAccessUnlock.findOne({
    user: userId,
    resourceType: RESOURCE_TYPE_WHEEL,
    resource: cfg._id
  });

  if (doc) {
    doc.status = adsRequired === 0 ? 'unlocked' : 'in_progress';
    doc.verifiedCount = 0;
    doc.rewards = [];
    doc.unlockedAt = adsRequired === 0 ? new Date() : null;
    doc.expiresAt = null;
  } else {
    doc = new UserAccessUnlock({
      user: userId,
      resourceType: RESOURCE_TYPE_WHEEL,
      resource: cfg._id,
      status: adsRequired === 0 ? 'unlocked' : 'in_progress',
      unlockedAt: adsRequired === 0 ? new Date() : null
    });
  }

  doc.selectedOption = { adsRequired, durationMinutes: null };
  doc.nonce = crypto.randomBytes(24).toString('hex');
  await doc.save();

  if (useFreeSpin) {
    stats.freeSpinsRemaining = Math.max(0, stats.freeSpinsRemaining - 1);
    await stats.save();
  }

  return {
    nonce: doc.nonce,
    adsRequired,
    adsWatched: 0,
    completed: adsRequired === 0,
    wasFreeSpin: useFreeSpin,
    freeSpinsRemaining: stats.freeSpinsRemaining
  };
}

/**
 * État courant. Si unlocked et pas encore finalisé → tirage + distribution.
 */
async function getState(userId, lang = 'fr') {
  const cfg = await WheelConfig.getSingleton();
  const stats = await WheelUserStats.getOrCreate(userId);

  const doc = await UserAccessUnlock.findOne({
    user: userId,
    resourceType: RESOURCE_TYPE_WHEEL,
    resource: cfg._id
  });

  if (!doc || (!doc.nonce && doc.status === 'in_progress')) {
    return {
      hasActiveSpin: false,
      adsRequired: cfg.adsPerSpin,
      adsWatched: 0,
      completed: false,
      nonce: null,
      freeSpinsRemaining: stats.freeSpinsRemaining,
      spin: null
    };
  }

  const adsRequired = doc.selectedOption?.adsRequired ?? cfg.adsPerSpin;
  const view = {
    hasActiveSpin: doc.status === 'in_progress',
    adsRequired,
    adsWatched: Math.min(doc.verifiedCount || 0, adsRequired || Number.MAX_SAFE_INTEGER),
    completed: doc.status === 'unlocked',
    nonce: doc.nonce,
    freeSpinsRemaining: stats.freeSpinsRemaining,
    spin: null
  };

  if (doc.status === 'unlocked') {
    view.spin = await finalize(doc, userId, lang);
    // Après finalize, l'unlock est reset → on reflète l'état "prêt pour
    // un nouveau spin" mais on garde `spin` pour que le client affiche le résultat.
    view.completed = true;
    view.hasActiveSpin = false;
    // adsWatched stays at adsRequired pour la barre de progression UI
  }
  return view;
}

/**
 * Tire un lot, applique, crée WheelSpin (idempotent via unlockId unique),
 * puis RESET l'UserAccessUnlock.
 */
async function finalize(doc, userId, lang = 'fr') {
  // Idempotence stricte : un WheelSpin déjà créé pour cet unlock ?
  const existing = await WheelSpin.findOne({ unlockId: doc._id }).populate('prize');
  if (existing) return formatSpin(existing, lang);

  const prize = await drawPrize(userId);
  const stats = await WheelUserStats.getOrCreate(userId);

  // Snapshot du prize (résistant aux modifs admin)
  const snapshot = {
    name: prize.name,
    type: prize.type,
    cash: prize.cash,
    physical: prize.physical,
    subscription: prize.subscription,
    freeSpin: prize.freeSpin
  };

  let status = 'won';
  let walletTxId = null;
  let subId = null;

  try {
    if (prize.type === 'cash') {
      const amount = prize.cash?.amount || 0;
      const currency = (prize.cash?.currency || 'XAF').toUpperCase();
      if (amount > 0) {
        const { transaction } = await walletService.credit({
          userId,
          amount,
          currency,
          source: { kind: 'wheel_spin', ref: doc._id },
          description: `Gain roue: ${prize.name?.fr || 'cash'}`
        });
        walletTxId = transaction._id;
        status = 'claimed_auto';
      } else {
        status = 'claimed_auto';
      }
    } else if (prize.type === 'free_spin') {
      stats.freeSpinsRemaining += prize.freeSpin?.count || 1;
      await stats.save();
      status = 'claimed_auto';
    } else if (prize.type === 'subscription') {
      if (prize.subscription?.packageId) {
        const startDate = new Date();
        const endDate = new Date(
          startDate.getTime() + (prize.subscription.durationHours || 24) * 3600 * 1000
        );
        const sub = await Subscription.create({
          user: userId,
          package: prize.subscription.packageId,
          startDate,
          endDate,
          pricing: { amount: 0, currency: 'XAF' },
          status: 'active',
          paymentProvider: 'ADS',
          paymentReference: `wheel:${doc._id.toString()}`
        });
        subId = sub._id;
        status = 'claimed_auto';
      } else {
        status = 'claimed_auto';
      }
    } else if (prize.type === 'physical') {
      status = 'pending_delivery';
    } else {
      // 'none' / Dommage
      status = 'claimed_auto';
    }
  } catch (e) {
    // On enregistre quand même le spin pour traçabilité (l'admin pourra
    // re-traiter manuellement le crédit). Log non bloquant.
    console.error('[wheelService.finalize] Apply prize failed:', e.message);
  }

  let spin;
  try {
    spin = await WheelSpin.create({
      user: userId,
      prize: prize._id,
      prizeSnapshot: snapshot,
      unlockId: doc._id,
      adsRequired: doc.selectedOption?.adsRequired || 0,
      wasFreeSpin: (doc.selectedOption?.adsRequired || 0) === 0,
      status,
      walletTransaction: walletTxId,
      subscriptionCreated: subId
    });
  } catch (e) {
    // E11000 = race condition sur l'index unique unlockId → on relit
    if (e.code === 11000) {
      const existing2 = await WheelSpin.findOne({ unlockId: doc._id }).populate('prize');
      if (existing2) return formatSpin(existing2, lang);
    }
    throw e;
  }

  // Stats user
  stats.lastSpinAt = new Date();
  stats.totalSpins = (stats.totalSpins || 0) + 1;
  await stats.save();

  // Reset de l'unlock pour permettre le prochain spin
  doc.status = 'in_progress';
  doc.verifiedCount = 0;
  doc.rewards = [];
  doc.unlockedAt = null;
  doc.expiresAt = null;
  doc.nonce = null;
  doc.selectedOption = { adsRequired: null, durationMinutes: null };
  await doc.save();

  // Populate prize pour la vue retournée
  await spin.populate('prize');
  return formatSpin(spin, lang);
}

/**
 * Formatte un WheelSpin pour le client. Utilise le snapshot pour les champs
 * (résiste aux suppressions/modifs du WheelPrize).
 */
function formatSpin(spin, lang = 'fr') {
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
 * Config publique pour le client mobile : liste ordonnée des lots visibles
 * (sans probas ni caps), config UI (adsPerSpin, etc.).
 */
async function getPublicConfig(lang = 'fr') {
  const cfg = await WheelConfig.getSingleton();
  const prizes = await WheelPrize.find({ enabled: true }).sort({ order: 1, createdAt: 1 });
  return {
    wheelEnabled: cfg.wheelEnabled,
    adsPerSpin: cfg.adsPerSpin,
    cooldownSec: cfg.cooldownSec,
    dailyMaxSpinsPerUser: cfg.dailyMaxSpinsPerUser,
    defaultCurrency: cfg.defaultCurrency,
    prizes: prizes.map(p => p.toPublicJSON(lang))
  };
}

/**
 * Historique des spins d'un user (paginé, descendant).
 */
async function getHistory(userId, { limit = 20, skip = 0, lang = 'fr' } = {}) {
  const spins = await WheelSpin.find({ user: userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Math.min(limit, 100))
    .populate('prize');
  return spins.map(s => formatSpin(s, lang));
}

module.exports = {
  RESOURCE_TYPE_WHEEL,
  start,
  getState,
  drawPrize,
  finalize,
  getPublicConfig,
  getHistory
};
