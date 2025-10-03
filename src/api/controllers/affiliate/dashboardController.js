const dashboardService = require('../../services/affiliate/dashboardService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir les statistiques générales du dashboard affilié
 */
exports.getDashboardStats = catchAsync(async (req, res, next) => {
  const stats = await dashboardService.getAffiliateStats(req.affiliate._id);

  res.status(200).json({
    success: true,
    data: {
      stats
    }
  });
});

/**
 * Obtenir la liste des filleuls
 */
exports.getReferrals = catchAsync(async (req, res, next) => {
  const { offset = 0, limit = 20 } = req.query;

  const result = await dashboardService.getReferrals(
    req.affiliate._id,
    offset,
    limit
  );

  res.status(200).json({
    success: true,
    data: result
  });
});

/**
 * Obtenir l'historique des commissions
 */
exports.getMyCommissions = catchAsync(async (req, res, next) => {
  const { 
    offset = 0, 
    limit = 20, 
    status, 
    month, 
    year, 
    startDate, 
    endDate 
  } = req.query;

  const filters = {};
  if (status) filters.status = status;
  if (month && year) {
    filters.month = month;
    filters.year = year;
  }
  if (startDate && endDate) {
    filters.startDate = startDate;
    filters.endDate = endDate;
  }

  const result = await dashboardService.getCommissions(
    req.affiliate._id,
    offset,
    limit,
    filters
  );

  res.status(200).json({
    success: true,
    data: result
  });
});

/**
 * Obtenir l'évolution des gains
 */
exports.getEarningsEvolution = catchAsync(async (req, res, next) => {
  const { months = 6 } = req.query;

  const evolution = await dashboardService.getEarningsEvolution(
    req.affiliate._id,
    parseInt(months)
  );

  res.status(200).json({
    success: true,
    data: {
      evolution,
      period: `${months} derniers mois`
    }
  });
});

/**
 * Obtenir les packages les plus vendus
 */
exports.getTopPackages = catchAsync(async (req, res, next) => {
  const { limit = 5 } = req.query;

  const topPackages = await dashboardService.getTopPackages(
    req.affiliate._id,
    parseInt(limit)
  );

  res.status(200).json({
    success: true,
    data: {
      topPackages
    }
  });
});

/**
 * Obtenir le résumé du mois en cours
 */
exports.getCurrentMonthSummary = catchAsync(async (req, res, next) => {
  const summary = await dashboardService.getCurrentMonthSummary(req.affiliate._id);

  res.status(200).json({
    success: true,
    data: {
      summary
    }
  });
});

/**
 * Obtenir les informations de l'affilié avec son code
 */
exports.getAffiliateInfo = catchAsync(async (req, res, next) => {
  const affiliate = req.affiliate;

  res.status(200).json({
    success: true,
    data: {
      affiliate: {
        id: affiliate._id,
        firstName: affiliate.firstName,
        lastName: affiliate.lastName,
        email: affiliate.email,
        phone: affiliate.phone,
        affiliateCode: affiliate.affiliateCode,
        commissionRate: affiliate.commissionRate,
        balances: {
          pending: affiliate.pendingBalance,
          paid: affiliate.paidBalance,
          total: affiliate.totalEarnings
        },
        paymentInfo: affiliate.paymentInfo,
        createdAt: affiliate.createdAt
      }
    }
  });
});

/**
 * Obtenir les statistiques détaillées pour une période
 */
exports.getPeriodStats = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return next(new AppError('Dates de début et fin requises', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Valider les dates
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return next(new AppError('Format de date invalide', 400, ErrorCodes.VALIDATION_ERROR));
  }

  if (start >= end) {
    return next(new AppError('La date de début doit être antérieure à la date de fin', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const affiliateManagementService = require('../../services/admin/affiliateManagementService');
  const stats = await affiliateManagementService.calculateAffiliateMetrics(
    req.affiliate._id,
    startDate,
    endDate
  );

  res.status(200).json({
    success: true,
    data: {
      stats
    }
  });
});

/**
 * Rechercher dans les filleuls
 */
exports.searchReferrals = catchAsync(async (req, res, next) => {
  const { 
    search, 
    offset = 0, 
    limit = 20, 
    hasActiveSubscription 
  } = req.query;

  if (!search || search.trim().length < 2) {
    return next(new AppError('Terme de recherche requis (minimum 2 caractères)', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const User = require('../../models/user/User');
  const Subscription = require('../../models/user/Subscription');

  // Construire le filtre de recherche
  const searchFilter = {
    referredBy: req.affiliate._id,
    $or: [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } }
    ]
  };

  let users = await User.find(searchFilter)
    .select('phone firstName lastName createdAt')
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  // Filtrer par abonnement actif si demandé
  if (hasActiveSubscription === 'true') {
    const userIds = users.map(u => u._id);
    const usersWithActiveSubscriptions = await Subscription.distinct('user', {
      user: { $in: userIds },
      status: 'active',
      endDate: { $gt: new Date() }
    });

    users = users.filter(user => 
      usersWithActiveSubscriptions.includes(user._id)
    );
  }

  const total = await User.countDocuments(searchFilter);

  res.status(200).json({
    success: true,
    data: {
      referrals: users,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      },
      searchTerm: search
    }
  });
});