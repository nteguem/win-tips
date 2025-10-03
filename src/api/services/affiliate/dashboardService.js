const User = require('../../models/user/User');
const Commission = require('../../models/common/Commission');
const Subscription = require('../../models/common/Subscription');

class DashboardService {
  /**
   * Obtenir les statistiques générales d'un affilié
   */
  async getAffiliateStats(affiliateId) {
    // Balance actuelle
    const affiliate = await require('../../models/affiliate/Affiliate').findById(affiliateId);
    
    // Nombre total de filleuls
    const totalReferrals = await User.countDocuments({ referredBy: affiliateId });
    
    // Filleuls ce mois
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    
    const monthlyReferrals = await User.countDocuments({
      referredBy: affiliateId,
      createdAt: { $gte: startOfMonth }
    });

    // Commissions par statut
    const commissionStats = await Commission.aggregate([
      { $match: { affiliate: affiliateId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$commissionAmount' }
        }
      }
    ]);

    // Revenus ce mois
    const monthlyRevenue = await Commission.aggregate([
      {
        $match: {
          affiliate: affiliateId,
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          amount: { $sum: '$commissionAmount' }
        }
      }
    ]);

    return {
      balances: {
        pending: affiliate.pendingBalance,
        paid: affiliate.paidBalance,
        total: affiliate.totalEarnings
      },
      referrals: {
        total: totalReferrals,
        thisMonth: monthlyReferrals
      },
      commissions: commissionStats,
      monthlyRevenue: monthlyRevenue[0]?.amount || 0,
      commissionRate: affiliate.commissionRate
    };
  }

  /**
   * Obtenir la liste des filleuls d'un affilié
   */
async getReferrals(affiliateId, offset = 0, limit = 20) {
  const referrals = await User.find({ referredBy: affiliateId })
    .select('phoneNumber pseudo countryCode createdAt')
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await User.countDocuments({ referredBy: affiliateId });
  
  // Compter les filleuls actifs (avec abonnements)
  const activeReferralsCount = await User.aggregate([
    { $match: { referredBy: affiliateId } },
    {
      $lookup: {
        from: 'subscriptions',
        localField: '_id',
        foreignField: 'user',
        as: 'subscriptions'
      }
    },
    {
      $match: {
        'subscriptions.status': 'active',
        'subscriptions.endDate': { $gt: new Date() }
      }
    },
    { $count: 'activeCount' }
  ]);

  // Enrichir avec les forfaits achetés et commissions
  const enrichedReferrals = await Promise.all(
    referrals.map(async (user) => {
      // Abonnements actifs
      const activeSubscriptions = await Subscription.countDocuments({
        user: user._id,
        status: 'active',
        endDate: { $gt: new Date() }
      });

      // Total dépensé
      const totalSpent = await Subscription.aggregate([
        { $match: { user: user._id } },
        { $group: { _id: null, total: { $sum: '$pricing.amount' } } }
      ]);

      // Liste des forfaits achetés avec détails
      const packages = await Subscription.find({ user: user._id })
        .populate('package', 'name')
        .select('package pricing status startDate endDate');

      // Commissions totales générées par ce filleul
      const totalCommissions = await Commission.aggregate([
        { $match: { affiliate: affiliateId, user: user._id } },
        { $group: { _id: null, total: { $sum: '$commissionAmount' } } }
      ]);

      return {
        ...user.toObject(),
        activeSubscriptions,
        totalSpent: totalSpent[0]?.total || 0,
        packages: packages.map(pkg => ({
          name: pkg.package?.name?.fr || 'Package inconnu',
          amount: pkg.pricing?.amount || 0,
          currency: pkg.pricing?.currency || 'XAF',
          status: pkg.status,
          startDate: pkg.startDate,
          endDate: pkg.endDate
        })),
        totalCommissions: totalCommissions[0]?.total || 0
      };
    })
  );

  return {
    referrals: enrichedReferrals,
    pagination: {
      offset: parseInt(offset),
      limit: parseInt(limit),
      total,
      active: activeReferralsCount[0]?.activeCount || 0
    }
  };
}

 /**
 * Obtenir l'historique des commissions d'un affilié
 */
async getCommissions(affiliateId, offset = 0, limit = 20, filters = {}) {
  const matchFilter = { affiliate: affiliateId };

  // Filtres optionnels
  if (filters.status) {
    matchFilter.status = filters.status;
  }
  if (filters.month && filters.year) {
    matchFilter.month = parseInt(filters.month);
    matchFilter.year = parseInt(filters.year);
  }
  if (filters.startDate && filters.endDate) {
    matchFilter.createdAt = {
      $gte: new Date(filters.startDate),
      $lte: new Date(filters.endDate)
    };
  }
  const commissions = await Commission.find(matchFilter)
    .populate('user', 'phone firstName lastName')
    .populate({
      path: 'subscription',
      select: 'pricing startDate endDate',
      populate: {
        path: 'package',
        select: 'name'
      }
    })
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Commission.countDocuments(matchFilter);

  return {
    commissions,
    pagination: {
      offset: parseInt(offset),
      limit: parseInt(limit),
      total
    }
  };
}

  /**
   * Obtenir l'évolution des gains par mois
   */
  async getEarningsEvolution(affiliateId, months = 6) {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);

    const evolution = await Commission.aggregate([
      {
        $match: {
          affiliate: affiliateId,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            year: '$year',
            month: '$month'
          },
          totalCommissions: { $sum: '$commissionAmount' },
          commissionsCount: { $sum: 1 },
          totalSales: { $sum: '$amount' }
        }
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1 }
      }
    ]);

    return evolution.map(item => ({
      period: `${item._id.year}-${String(item._id.month).padStart(2, '0')}`,
      totalCommissions: item.totalCommissions,
      commissionsCount: item.commissionsCount,
      totalSales: item.totalSales
    }));
  }

  /**
   * Obtenir les packages les plus vendus par cet affilié
   */
  async getTopPackages(affiliateId, limit = 5) {
    const topPackages = await Commission.aggregate([
      { $match: { affiliate: affiliateId } },
      {
        $lookup: {
          from: 'subscriptions',
          localField: 'subscription',
          foreignField: '_id',
          as: 'subscription'
        }
      },
      { $unwind: '$subscription' },
      {
        $lookup: {
          from: 'packages',
          localField: 'subscription.package',
          foreignField: '_id',
          as: 'package'
        }
      },
      { $unwind: '$package' },
      {
        $group: {
          _id: '$package._id',
          packageName: { $first: '$package.name' },
          salesCount: { $sum: 1 },
          totalCommissions: { $sum: '$commissionAmount' },
          totalRevenue: { $sum: '$amount' }
        }
      },
      { $sort: { salesCount: -1 } },
      { $limit: parseInt(limit) }
    ]);

    return topPackages;
  }

  /**
   * Obtenir le résumé mensuel actuel
   */
  async getCurrentMonthSummary(affiliateId) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Nouvelles inscriptions
    const newReferrals = await User.countDocuments({
      referredBy: affiliateId,
      createdAt: { $gte: startOfMonth, $lte: endOfMonth }
    });

    // Commissions du mois
    const monthCommissions = await Commission.aggregate([
      {
        $match: {
          affiliate: affiliateId,
          month: now.getMonth() + 1,
          year: now.getFullYear()
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          amount: { $sum: '$commissionAmount' }
        }
      }
    ]);

    // Abonnements actifs des filleuls
    const referralIds = await User.find({ referredBy: affiliateId }).distinct('_id');
    const activeSubscriptions = await Subscription.countDocuments({
      user: { $in: referralIds },
      status: 'active',
      endDate: { $gt: new Date() }
    });

    return {
      period: {
        month: now.getMonth() + 1,
        year: now.getFullYear(),
        monthName: now.toLocaleString('fr', { month: 'long' })
      },
      newReferrals,
      activeSubscriptions,
      commissions: monthCommissions
    };
  }
}

module.exports = new DashboardService();