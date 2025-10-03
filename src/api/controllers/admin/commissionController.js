const commissionService = require('../../services/common/commissionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir les statistiques globales des commissions
 */
exports.getCommissionStats = catchAsync(async (req, res, next) => {
  const stats = await commissionService.getCommissionStats();

  res.status(200).json({
    success: true,
    data: {
      stats
    }
  });
});

/**
 * Recalculer les balances des affiliés (maintenance)
 */
exports.recalculateBalances = catchAsync(async (req, res, next) => {
  const report = await commissionService.recalculateAffiliateBalances();

  res.status(200).json({
    success: true,
    message: 'Recalcul des balances terminé',
    data: {
      report,
      updatedAffiliates: report.length
    }
  });
});

/**
 * Annuler des commissions spécifiques (garde pour cas exceptionnels)
 */
exports.cancelCommissions = catchAsync(async (req, res, next) => {
  const { commissionIds, reason } = req.body;

  if (!commissionIds || !Array.isArray(commissionIds) || commissionIds.length === 0) {
    return next(new AppError('Liste des IDs de commissions requise', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const report = await commissionService.cancelCommissions(commissionIds, reason);

  res.status(200).json({
    success: true,
    message: `${report.cancelledCount} commissions annulées`,
    data: {
      report
    }
  });
});