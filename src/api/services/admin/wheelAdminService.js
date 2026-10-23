// src/api/services/admin/wheelAdminService.js
//
// Services admin pour la gestion de la roue : CRUD lots, config globale,
// historique des spins, file des gains physiques à livrer, validation des
// retraits cash.

const WheelPrize = require('../../models/common/WheelPrize');
const WheelConfig = require('../../models/common/WheelConfig');
const WheelSpin = require('../../models/common/WheelSpin');
const WheelUserStats = require('../../models/common/WheelUserStats');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

// ====== CONFIG ============================================================

async function getConfig() {
  const cfg = await WheelConfig.getSingleton();
  return cfg.toAdminJSON();
}

async function updateConfig(updates) {
  const cfg = await WheelConfig.getSingleton();
  const allowed = [
    'wheelEnabled',
    'adsPerSpin',
    'cooldownSec',
    'dailyMaxSpinsPerUser',
    'defaultCurrency'
  ];
  for (const k of allowed) {
    if (updates[k] !== undefined) cfg[k] = updates[k];
  }
  if (updates.withdrawalThresholds && typeof updates.withdrawalThresholds === 'object') {
    for (const [curr, value] of Object.entries(updates.withdrawalThresholds)) {
      cfg.withdrawalThresholds.set(String(curr).toUpperCase(), Number(value));
    }
  }
  await cfg.save();
  return cfg.toAdminJSON();
}

// ====== PRIZES ============================================================

async function listPrizes() {
  const prizes = await WheelPrize.find({}).sort({ order: 1, createdAt: 1 });
  return prizes.map(p => p.toAdminJSON());
}

async function createPrize(data) {
  if (!data || !data.name || !data.name.fr || !data.name.en) {
    throw new AppError('Le nom (fr & en) est requis.', 400, ErrorCodes.VALIDATION_ERROR);
  }
  if (!data.type) {
    throw new AppError('Le type est requis.', 400, ErrorCodes.VALIDATION_ERROR);
  }
  // Si on crée un fallback, démarquer les autres
  if (data.isFallback === true) {
    await WheelPrize.updateMany({ isFallback: true }, { $set: { isFallback: false } });
  }
  const prize = await WheelPrize.create(data);
  return prize.toAdminJSON();
}

async function updatePrize(id, updates) {
  const prize = await WheelPrize.findById(id);
  if (!prize) throw new AppError('Lot introuvable.', 404, ErrorCodes.NOT_FOUND);

  // Garantit l'unicité du fallback
  if (updates.isFallback === true && !prize.isFallback) {
    await WheelPrize.updateMany(
      { _id: { $ne: prize._id }, isFallback: true },
      { $set: { isFallback: false } }
    );
  }

  const allowed = [
    'name', 'type', 'cash', 'subscription', 'physical', 'freeSpin',
    'color', 'icon', 'order', 'weight', 'enabled', 'caps', 'isFallback'
  ];
  for (const k of allowed) {
    if (updates[k] !== undefined) prize[k] = updates[k];
  }
  await prize.save();
  return prize.toAdminJSON();
}

async function deletePrize(id) {
  const prize = await WheelPrize.findById(id);
  if (!prize) throw new AppError('Lot introuvable.', 404, ErrorCodes.NOT_FOUND);

  // Refus si des spins historiques le référencent (intégrité audit)
  const count = await WheelSpin.countDocuments({ prize: prize._id });
  if (count > 0) {
    throw new AppError(
      `Impossible de supprimer : ${count} gain(s) historique(s) référence(nt) ce lot. Désactive-le plutôt.`,
      400,
      ErrorCodes.OPERATION_NOT_ALLOWED
    );
  }
  await prize.deleteOne();
  return { deleted: true, _id: id };
}

async function togglePrize(id) {
  const prize = await WheelPrize.findById(id);
  if (!prize) throw new AppError('Lot introuvable.', 404, ErrorCodes.NOT_FOUND);
  prize.enabled = !prize.enabled;
  await prize.save();
  return prize.toAdminJSON();
}

// ====== SPINS / HISTORIQUE ================================================

async function listSpins({ status, prizeId, userId, fromDate, toDate, limit = 50, skip = 0 } = {}) {
  const q = {};
  if (status) q.status = status;
  if (prizeId) q.prize = prizeId;
  if (userId) q.user = userId;
  if (fromDate || toDate) {
    q.createdAt = {};
    if (fromDate) q.createdAt.$gte = new Date(fromDate);
    if (toDate) q.createdAt.$lte = new Date(toDate);
  }
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const sk = parseInt(skip, 10) || 0;
  const [items, total] = await Promise.all([
    WheelSpin.find(q)
      .sort({ createdAt: -1 })
      .skip(sk)
      .limit(lim)
      .populate('prize')
      .populate('user', 'pseudo phoneNumber email')
      .populate('walletTransaction')
      .populate('subscriptionCreated'),
    WheelSpin.countDocuments(q)
  ]);
  return { items, total, limit: lim, skip: sk };
}

async function markDelivered(spinId, adminNotes) {
  const spin = await WheelSpin.findById(spinId);
  if (!spin) throw new AppError('Spin introuvable.', 404, ErrorCodes.NOT_FOUND);
  if (spin.status !== 'pending_delivery') {
    throw new AppError(
      'Ce gain n\'est pas en attente de livraison.',
      400,
      ErrorCodes.OPERATION_NOT_ALLOWED
    );
  }
  spin.status = 'delivered';
  if (adminNotes) spin.adminNotes = adminNotes;
  await spin.save();
  return spin;
}

async function markPaid(spinId, adminNotes) {
  const spin = await WheelSpin.findById(spinId);
  if (!spin) throw new AppError('Spin introuvable.', 404, ErrorCodes.NOT_FOUND);
  if (!['claimed_auto', 'won'].includes(spin.status)) {
    throw new AppError(
      'Ce gain ne peut pas être marqué payé.',
      400,
      ErrorCodes.OPERATION_NOT_ALLOWED
    );
  }
  spin.status = 'paid';
  if (adminNotes) spin.adminNotes = adminNotes;
  await spin.save();
  return spin;
}

// ====== STATS GLOBALES ====================================================

async function getStats({ fromDate, toDate } = {}) {
  const match = {};
  if (fromDate || toDate) {
    match.createdAt = {};
    if (fromDate) match.createdAt.$gte = new Date(fromDate);
    if (toDate) match.createdAt.$lte = new Date(toDate);
  }
  const [totalSpins, byPrize, byStatus] = await Promise.all([
    WheelSpin.countDocuments(match),
    WheelSpin.aggregate([
      { $match: match },
      { $group: { _id: '$prize', count: { $sum: 1 } } },
      { $lookup: { from: 'wheelprizes', localField: '_id', foreignField: '_id', as: 'prize' } },
      { $unwind: { path: '$prize', preserveNullAndEmptyArrays: true } },
      { $sort: { count: -1 } }
    ]),
    WheelSpin.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);
  return { totalSpins, byPrize, byStatus };
}

module.exports = {
  getConfig,
  updateConfig,
  listPrizes,
  createPrize,
  updatePrize,
  deletePrize,
  togglePrize,
  listSpins,
  markDelivered,
  markPaid,
  getStats
};
