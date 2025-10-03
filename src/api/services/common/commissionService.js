const Subscription = require('../../models/common/Subscription');
const Commission = require('../../models/common/Commission');
const Affiliate = require('../../models/affiliate/Affiliate');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

class CommissionService {
  /**
   * Créer une commission pour un abonnement
   */
  async createCommission(subscriptionId) {
    const subscription = await Subscription.findById(subscriptionId)
      .populate('user')
      .populate('package');

    // Vérifier si l'user a un parrain
    if (!subscription.user.referredBy) return null;

    const affiliate = await Affiliate.findById(subscription.user.referredBy)
      .populate('affiliateType');
    if (!affiliate || !affiliate.isActive) return null;

    // Vérifier que l'affilié a un type avec un taux de commission
    if (!affiliate.affiliateType) return null;

    // Vérifier si commission existe déjà
    const existingCommission = await Commission.findOne({ subscription: subscriptionId });
    if (existingCommission) return existingCommission;

    // Calculer la commission avec le taux du type
    const commissionRate = affiliate.affiliateType.commissionRate;
    const commissionAmount = (subscription.pricing.amount * commissionRate) / 100;

    // Créer l'enregistrement
    const commission = await Commission.create({
      affiliate: affiliate._id,
      user: subscription.user._id,
      subscription: subscription._id,
      amount: subscription.pricing.amount,
      currency: subscription.pricing.currency,
      commissionRate,
      commissionAmount,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });

    // Mettre à jour le solde en attente
    affiliate.pendingBalance += commissionAmount;
    affiliate.totalEarnings += commissionAmount;
    await affiliate.save();

    return commission;
  }

/**
 * Calculer (compter) les commissions pending d'un affilié pour un mois donné - groupées par devise
 */
async calculateAffiliateCommissions(affiliateId, month, year) {
  const pendingCommissions = await Commission.find({
    affiliate: affiliateId,
    month,
    year,
    status: 'pending'
  }).sort({ createdAt: -1 });

  // Grouper par devise directement
  const commissionsByCurrency = {};
  let totalCommissions = 0;

  pendingCommissions.forEach(commission => {
    const currency = commission.currency;
    
    if (!commissionsByCurrency[currency]) {
      commissionsByCurrency[currency] = {
        currency,
        totalAmount: 0,
        count: 0,
        commissions: []
      };
    }

    commissionsByCurrency[currency].totalAmount += commission.commissionAmount;
    commissionsByCurrency[currency].count += 1;
    commissionsByCurrency[currency].commissions.push({
      id: commission._id,
      subscriptionId: commission.subscription, // ID brut, sans populate
      userId: commission.user, // ID brut, sans populate
      amount: commission.amount,
      currency: commission.currency,
      commissionRate: commission.commissionRate,
      commissionAmount: commission.commissionAmount,
      createdAt: commission.createdAt
    });

    totalCommissions++;
  });

  const report = {
    period: { month, year },
    affiliateId,
    totalPending: totalCommissions,
    currencyBreakdown: Object.values(commissionsByCurrency),
    allCommissions: pendingCommissions.map(commission => ({
      id: commission._id,
      subscriptionId: commission.subscription, // ID brut
      userId: commission.user, // ID brut
      amount: commission.amount,
      currency: commission.currency,
      commissionRate: commission.commissionRate,
      commissionAmount: commission.commissionAmount,
      createdAt: commission.createdAt
    }))
  };

  console.log(`✅ Traitement réussi: ${totalCommissions} commissions pending`);
  return report;
}

  /**
   * Obtenir les commissions en attente pour un affilié et un mois - groupées par devise
   */
  async getPendingAffiliateCommissions(affiliateId, month, year) {
    const commissions = await Commission.find({
      affiliate: affiliateId,
      month,
      year,
      status: 'pending'
    })
    .populate('user', 'phone firstName lastName')
    .populate('subscription', 'pricing createdAt')
    .sort({ createdAt: -1 });

    // Grouper par devise
    const totalsByCurrency = {};
    
    commissions.forEach(commission => {
      const currency = commission.currency;
      if (!totalsByCurrency[currency]) {
        totalsByCurrency[currency] = {
          currency,
          totalAmount: 0,
          count: 0
        };
      }
      totalsByCurrency[currency].totalAmount += commission.commissionAmount;
      totalsByCurrency[currency].count += 1;
    });

    return {
      period: { month, year },
      totalsByCurrency: Object.values(totalsByCurrency),
      commissionCount: commissions.length,
      commissions
    };
  }

  /**
   * Valider le paiement des commissions pending d'un affilié
   */
  async validateAffiliatePayment(affiliateId, month, year, paymentReference) {
    const pendingCommissions = await Commission.find({
      affiliate: affiliateId,
      month,
      year,
      status: 'pending'
    });

    if (pendingCommissions.length === 0) {
      throw new AppError('Aucune commission en attente pour cet affilié et cette période', 404, ErrorCodes.NOT_FOUND);
    }

    // Grouper les paiements par devise
    const paymentsByCurrency = {};
    let totalPaid = 0;

    // Mettre à jour toutes les commissions pending
    for (const commission of pendingCommissions) {
      commission.status = 'paid';
      commission.paidAt = new Date();
      commission.paymentReference = paymentReference;
      await commission.save();

      const currency = commission.currency;
      if (!paymentsByCurrency[currency]) {
        paymentsByCurrency[currency] = {
          currency,
          amount: 0,
          count: 0
        };
      }
      
      paymentsByCurrency[currency].amount += commission.commissionAmount;
      paymentsByCurrency[currency].count += 1;
      totalPaid += commission.commissionAmount;
    }

    // Mettre à jour les balances de l'affilié
    const affiliate = await Affiliate.findById(affiliateId);
    if (affiliate) {
      affiliate.pendingBalance -= totalPaid;
      affiliate.paidBalance += totalPaid;
      await affiliate.save();
    }

    const report = {
      period: { month, year },
      affiliateId,
      paymentReference,
      paidCommissions: pendingCommissions.length,
      paymentsByCurrency: Object.values(paymentsByCurrency),
      totalPaid
    };

    return report;
  }

  /**
   * Annuler des commissions
   */
  async cancelCommissions(commissionIds, reason = '') {
    const commissions = await Commission.find({
      _id: { $in: commissionIds },
      status: 'pending'
    });

    if (commissions.length === 0) {
      throw new AppError('Aucune commission éligible à l\'annulation', 404, ErrorCodes.NOT_FOUND);
    }

    const report = {
      cancelledCount: commissions.length,
      totalAmount: 0,
      reason
    };

    for (const commission of commissions) {
      commission.status = 'cancelled';
      await commission.save();

      report.totalAmount += commission.commissionAmount;

      // Mettre à jour les balances de l'affilié
      const affiliate = await Affiliate.findById(commission.affiliate);
      if (affiliate) {
        affiliate.pendingBalance -= commission.commissionAmount;
        affiliate.totalEarnings -= commission.commissionAmount;
        await affiliate.save();
      }
    }

    return report;
  }

  /**
   * Obtenir les statistiques globales des commissions
   */
  async getCommissionStats() {
    const stats = await Commission.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$commissionAmount' }
        }
      }
    ]);

    // Stats par devise
    const currencyStats = await Commission.aggregate([
      {
        $group: {
          _id: {
            status: '$status',
            currency: '$currency'
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$commissionAmount' }
        }
      },
      {
        $sort: { '_id.currency': 1, '_id.status': 1 }
      }
    ]);

    const monthlyStats = await Commission.aggregate([
      {
        $group: {
          _id: {
            year: '$year',
            month: '$month'
          },
          totalCommissions: { $sum: '$commissionAmount' },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.year': -1, '_id.month': -1 }
      },
      { $limit: 12 }
    ]);

    return {
      overallStats: stats,
      currencyStats,
      monthlyEvolution: monthlyStats.reverse()
    };
  }

  /**
   * Obtenir le rapport détaillé d'une période
   */
  async getDetailedReport(month, year) {
    const commissions = await Commission.find({ month, year })
      .populate({
        path: 'affiliate',
        select: 'affiliateCode firstName lastName',
        populate: {
          path: 'affiliateType',
          select: 'name commissionRate'
        }
      })
      .populate('user', 'phone firstName lastName createdAt')
      .populate({
        path: 'subscription',
        populate: {
          path: 'package',
          select: 'name pricing'
        }
      })
      .sort({ createdAt: -1 });

    const summary = await Commission.aggregate([
      { $match: { month, year } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$commissionAmount' }
        }
      }
    ]);

    // Summary par devise
    const currencySummary = await Commission.aggregate([
      { $match: { month, year } },
      {
        $group: {
          _id: {
            status: '$status',
            currency: '$currency'
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$commissionAmount' }
        }
      },
      {
        $sort: { '_id.currency': 1, '_id.status': 1 }
      }
    ]);

    return {
      period: { month, year },
      summary,
      currencySummary,
      commissions,
      totalCommissions: commissions.length
    };
  }

  /**
   * Recalculer les balances des affiliés
   */
  async recalculateAffiliateBalances() {
    const affiliates = await Affiliate.find({ isActive: true });
    const report = [];

    for (const affiliate of affiliates) {
      const commissionStats = await Commission.aggregate([
        { $match: { affiliate: affiliate._id } },
        {
          $group: {
            _id: '$status',
            totalAmount: { $sum: '$commissionAmount' }
          }
        }
      ]);

      let pendingBalance = 0;
      let paidBalance = 0;
      let totalEarnings = 0;

      commissionStats.forEach(stat => {
        if (stat._id === 'pending') pendingBalance = stat.totalAmount;
        if (stat._id === 'paid') paidBalance = stat.totalAmount;
        totalEarnings += stat.totalAmount;
      });

      // Mettre à jour l'affilié
      affiliate.pendingBalance = pendingBalance;
      affiliate.paidBalance = paidBalance;
      affiliate.totalEarnings = totalEarnings;
      await affiliate.save();

      report.push({
        affiliateCode: affiliate.affiliateCode,
        oldBalances: {
          pending: affiliate.pendingBalance,
          paid: affiliate.paidBalance,
          total: affiliate.totalEarnings
        },
        newBalances: {
          pending: pendingBalance,
          paid: paidBalance,
          total: totalEarnings
        }
      });
    }

    return report;
  }
}

module.exports = new CommissionService();