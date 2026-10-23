// src/api/controllers/admin/wheelAdminController.js
//
// Endpoints admin pour gérer la roue : config, lots (CRUD), historique des
// spins, marquage livré/payé, validation des retraits wallet.

const wheelAdminService = require('../../services/admin/wheelAdminService');
const walletService = require('../../services/common/walletService');
const catchAsync = require('../../../utils/catchAsync');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

// ====== CONFIG ============================================================

exports.getConfig = catchAsync(async (req, res) => {
  const data = await wheelAdminService.getConfig();
  res.status(200).json({ success: true, data });
});

exports.updateConfig = catchAsync(async (req, res) => {
  const data = await wheelAdminService.updateConfig(req.body || {});
  res.status(200).json({ success: true, data });
});

// ====== PRIZES (lots) =====================================================

exports.listPrizes = catchAsync(async (req, res) => {
  const data = await wheelAdminService.listPrizes();
  res.status(200).json({ success: true, data });
});

exports.createPrize = catchAsync(async (req, res) => {
  const data = await wheelAdminService.createPrize(req.body || {});
  res.status(201).json({ success: true, data });
});

exports.updatePrize = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await wheelAdminService.updatePrize(id, req.body || {});
  res.status(200).json({ success: true, data });
});

exports.deletePrize = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await wheelAdminService.deletePrize(id);
  res.status(200).json({ success: true, data });
});

exports.togglePrize = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await wheelAdminService.togglePrize(id);
  res.status(200).json({ success: true, data });
});

// ====== SPINS HISTORIQUE ==================================================

exports.listSpins = catchAsync(async (req, res) => {
  const data = await wheelAdminService.listSpins({
    status: req.query.status,
    prizeId: req.query.prizeId,
    userId: req.query.userId,
    fromDate: req.query.fromDate,
    toDate: req.query.toDate,
    limit: req.query.limit,
    skip: req.query.skip
  });
  res.status(200).json({ success: true, ...data });
});

exports.markDelivered = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await wheelAdminService.markDelivered(id, req.body?.adminNotes);
  res.status(200).json({ success: true, data });
});

exports.markPaid = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await wheelAdminService.markPaid(id, req.body?.adminNotes);
  res.status(200).json({ success: true, data });
});

// ====== WALLET / RETRAITS =================================================

exports.listWithdrawalRequests = catchAsync(async (req, res) => {
  const WalletTransaction = require('../../models/common/WalletTransaction');
  const q = { type: 'debit_withdrawal' };
  if (req.query.status) q.status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const skip = parseInt(req.query.skip, 10) || 0;
  const [items, total] = await Promise.all([
    WalletTransaction.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'pseudo phoneNumber email'),
    WalletTransaction.countDocuments(q)
  ]);
  res.status(200).json({ success: true, items, total, limit, skip });
});

exports.completeWithdrawal = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await walletService.completeWithdrawal({
    transactionId: id,
    adminNotes: req.body?.adminNotes
  });
  res.status(200).json({ success: true, data });
});

exports.cancelWithdrawal = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!id) return next(new AppError('id requis.', 400, ErrorCodes.VALIDATION_ERROR));
  const data = await walletService.cancelWithdrawal({
    transactionId: id,
    adminNotes: req.body?.adminNotes
  });
  res.status(200).json({ success: true, data });
});

// ====== STATS =============================================================

exports.getStats = catchAsync(async (req, res) => {
  const data = await wheelAdminService.getStats({
    fromDate: req.query.fromDate,
    toDate: req.query.toDate
  });
  res.status(200).json({ success: true, data });
});
