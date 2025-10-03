const Commission = require('../../models/common/Commission');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir toutes les commissions de l'affilié connecté
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

  const filters = { affiliate: req.affiliate._id };

  // Construire les filtres
  if (status) filters.status = status;
  if (month && year) {
    filters.month = parseInt(month);
    filters.year = parseInt(year);
  }
  if (startDate && endDate) {
    filters.createdAt = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }

  const commissions = await Commission.find(filters)
    .populate('user', 'phone firstName lastName')
    .populate({
      path: 'subscription',
      populate: {
        path: 'package',
        select: 'name pricing duration'
      }
    })
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Commission.countDocuments(filters);

  res.status(200).json({
    success: true,
    data: {
      commissions,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      }
    }
  });
});

/**
 * Obtenir les commissions en attente de l'affilié
 */
exports.getPendingCommissions = catchAsync(async (req, res, next) => {
  const { offset = 0, limit = 20 } = req.query;

  const commissions = await Commission.find({
    affiliate: req.affiliate._id,
    status: 'pending'
  })
    .populate('user', 'phone firstName lastName')
    .populate({
      path: 'subscription',
      populate: {
        path: 'package',
        select: 'name pricing duration'
      }
    })
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Commission.countDocuments({
    affiliate: req.affiliate._id,
    status: 'pending'
  });

  // Calculer le total en attente
  const pendingTotal = await Commission.aggregate([
    {
      $match: {
        affiliate: req.affiliate._id,
        status: 'pending'
      }
    },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$commissionAmount' }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      commissions,
      totalPendingAmount: pendingTotal[0]?.totalAmount || 0,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      }
    }
  });
});

/**
 * Obtenir les commissions payées de l'affilié
 */
exports.getPaidCommissions = catchAsync(async (req, res, next) => {
  const { offset = 0, limit = 20 } = req.query;

  const commissions = await Commission.find({
    affiliate: req.affiliate._id,
    status: 'paid'
  })
    .populate('user', 'phone firstName lastName')
    .populate({
      path: 'subscription',
      populate: {
        path: 'package',
        select: 'name pricing duration'
      }
    })
    .sort({ paidAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Commission.countDocuments({
    affiliate: req.affiliate._id,
    status: 'paid'
  });

  res.status(200).json({
    success: true,
    data: {
      commissions,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      }
    }
  });
});

/**
 * Obtenir une commission spécifique
 */
exports.getCommission = catchAsync(async (req, res, next) => {
  const commission = await Commission.findOne({
    _id: req.params.id,
    affiliate: req.affiliate._id
  })
    .populate('user', 'phone firstName lastName email createdAt')
    .populate({
      path: 'subscription',
      populate: {
        path: 'package',
        select: 'name description pricing duration features'
      }
    });

  if (!commission) {
    return next(new AppError('Commission non trouvée', 404, ErrorCodes.NOT_FOUND));
  }

  res.status(200).json({
    success: true,
    data: {
      commission
    }
  });
});

/**
 * Obtenir les statistiques des commissions par mois/année
 */
exports.getCommissionsByPeriod = catchAsync(async (req, res, next) => {
  const { months = 12 } = req.query;

  const stats = await Commission.aggregate([
    {
      $match: {
        affiliate: req.affiliate._id
      }
    },
    {
      $group: {
        _id: {
          year: '$year',
          month: '$month',
          status: '$status'
        },
        count: { $sum: 1 },
        totalAmount: { $sum: '$commissionAmount' }
      }
    },
    {
      $group: {
        _id: {
          year: '$_id.year',
          month: '$_id.month'
        },
        pending: {
          $sum: {
            $cond: [{ $eq: ['$_id.status', 'pending'] }, '$totalAmount', 0]
          }
        },
        paid: {
          $sum: {
            $cond: [{ $eq: ['$_id.status', 'paid'] }, '$totalAmount', 0]
          }
        },
        cancelled: {
          $sum: {
            $cond: [{ $eq: ['$_id.status', 'cancelled'] }, '$totalAmount', 0]
          }
        },
        totalCount: { $sum: '$count' }
      }
    },
    {
      $sort: { '_id.year': -1, '_id.month': -1 }
    },
    {
      $limit: parseInt(months)
    },
    {
      $project: {
        year: '$_id.year',
        month: '$_id.month',
        pending: 1,
        paid: 1,
        cancelled: 1,
        total: { $add: ['$pending', '$paid', '$cancelled'] },
        totalCount: 1,
        periodLabel: {
          $concat: [
            { $toString: '$_id.month' },
            '/',
            { $toString: '$_id.year' }
          ]
        }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      periods: stats.reverse() // Ordre chronologique
    }
  });
});

/**
 * Obtenir le résumé des commissions de l'affilié
 */
exports.getCommissionSummary = catchAsync(async (req, res, next) => {
  const summary = await Commission.aggregate([
    {
      $match: {
        affiliate: req.affiliate._id
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$commissionAmount' }
      }
    }
  ]);

  // Commissions de ce mois
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();

  const thisMonthStats = await Commission.aggregate([
    {
      $match: {
        affiliate: req.affiliate._id,
        month: currentMonth,
        year: currentYear
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$commissionAmount' }
      }
    }
  ]);

  // Évolution du mois dernier
  const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  const lastMonthStats = await Commission.aggregate([
    {
      $match: {
        affiliate: req.affiliate._id,
        month: lastMonth,
        year: lastMonthYear
      }
    },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$commissionAmount' }
      }
    }
  ]);

  const thisMonthTotal = thisMonthStats.reduce((acc, stat) => acc + stat.totalAmount, 0);
  const lastMonthTotal = lastMonthStats[0]?.totalAmount || 0;

  const growth = lastMonthTotal > 0 
    ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100 
    : 0;

  res.status(200).json({
    success: true,
    data: {
      overallSummary: summary,
      thisMonth: {
        stats: thisMonthStats,
        total: thisMonthTotal,
        period: `${currentMonth}/${currentYear}`
      },
      growth: {
        percentage: Math.round(growth * 100) / 100,
        trend: growth > 0 ? 'up' : growth < 0 ? 'down' : 'stable'
      }
    }
  });
});

/**
 * Rechercher dans les commissions
 */
exports.searchCommissions = catchAsync(async (req, res, next) => {
  const { 
    search, 
    offset = 0, 
    limit = 20 
  } = req.query;

  if (!search || search.trim().length < 2) {
    return next(new AppError('Terme de recherche requis (minimum 2 caractères)', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Rechercher dans les utilisateurs d'abord
  const User = require('../../models/user/User');
  const users = await User.find({
    $or: [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } }
    ]
  }).select('_id');

  const userIds = users.map(u => u._id);

  const commissions = await Commission.find({
    affiliate: req.affiliate._id,
    user: { $in: userIds }
  })
    .populate('user', 'phone firstName lastName')
    .populate({
      path: 'subscription',
      populate: {
        path: 'package',
        select: 'name pricing'
      }
    })
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Commission.countDocuments({
    affiliate: req.affiliate._id,
    user: { $in: userIds }
  });

  res.status(200).json({
    success: true,
    data: {
      commissions,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      },
      searchTerm: search
    }
  });
});