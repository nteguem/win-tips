const Affiliate = require('../../models/affiliate/Affiliate');
const User = require('../../models/user/User');
const Commission = require('../../models/common/Commission');
const Subscription = require('../../models/common/Subscription');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

class AffiliateManagementService {
  /**
   * Obtenir les détails complets d'un affilié avec ses statistiques
   */
  async getAffiliateDetails(affiliateId) {
    const affiliate = await Affiliate.findById(affiliateId)
      .select('-password -refreshTokens');

    if (!affiliate) {
      throw new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND);
    }

    // Statistiques de base
    const referredUsers = await User.find({ referredBy: affiliateId });
    const totalReferrals = referredUsers.length;

    // Commissions
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

    // Abonnements des filleuls
    const referralSubscriptions = await Subscription.aggregate([
      { 
        $match: { 
          user: { $in: referredUsers.map(u => u._id) },
          status: 'active'
        }
      },
      {
        $group: {
          _id: null,
          activeSubscriptions: { $sum: 1 },
          totalRevenue: { $sum: '$pricing.amount' }
        }
      }
    ]);

    return {
      affiliate,
      stats: {
        totalReferrals,
        activeSubscriptions: referralSubscriptions[0]?.activeSubscriptions || 0,
        totalRevenue: referralSubscriptions[0]?.totalRevenue || 0,
        commissions: commissionStats
      },
      referredUsers: referredUsers.map(user => ({
        id: user._id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: user.createdAt
      }))
    };
  }

  /**
   * Générer un code affilié unique
   */
  async generateUniqueAffiliateCode(baseName = '') {
    let code;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isUnique && attempts < maxAttempts) {
      // Générer code basé sur le nom ou aléatoire
      if (baseName) {
        const prefix = baseName.substring(0, 3).toUpperCase();
        const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        code = `${prefix}${suffix}`;
      } else {
        code = Math.random().toString(36).substring(2, 8).toUpperCase();
      }

      // Vérifier unicité
      const existing = await Affiliate.findOne({ affiliateCode: code });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new AppError('Impossible de générer un code unique', 500, ErrorCodes.INTERNAL_ERROR);
    }

    return code;
  }

  /**
   * Valider les données d'un affilié
   */
  async validateAffiliateData(data, isUpdate = false, currentAffiliateId = null) {
    const errors = [];

    // Validation téléphone
    if (data.phone) {
      // Validation basique : au moins 8 chiffres
      if (!/^[\+]?[1-9][\d]{7,14}$/.test(data.phone.replace(/\s/g, ''))) {
        errors.push('Format de téléphone invalide');
      }

      // Vérifier unicité du téléphone
      const phoneQuery = { phone: data.phone };
      if (isUpdate && currentAffiliateId) {
        phoneQuery._id = { $ne: currentAffiliateId };
      }

      const existingPhone = await Affiliate.findOne(phoneQuery);
      if (existingPhone) {
        errors.push('Ce numéro de téléphone est déjà utilisé');
      }
    }

    // Validation code affilié
    if (data.affiliateCode) {
      if (data.affiliateCode.length < 3 || data.affiliateCode.length > 10) {
        errors.push('Le code affilié doit contenir entre 3 et 10 caractères');
      }

      // Vérifier unicité du code
      const codeQuery = { affiliateCode: data.affiliateCode.toUpperCase() };
      if (isUpdate && currentAffiliateId) {
        codeQuery._id = { $ne: currentAffiliateId };
      }

      const existingCode = await Affiliate.findOne(codeQuery);
      if (existingCode) {
        errors.push('Ce code affilié est déjà utilisé');
      }
    }

    // Validation taux de commission
    if (data.commissionRate !== undefined) {
      if (data.commissionRate < 0 || data.commissionRate > 50) {
        errors.push('Le taux de commission doit être entre 0 et 50%');
      }
    }

    // Validation email
    if (data.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email)) {
        errors.push('Format d\'email invalide');
      }
    }

    if (errors.length > 0) {
      throw new AppError(errors.join(', '), 400, ErrorCodes.VALIDATION_ERROR);
    }

    return true;
  }

  /**
   * Obtenir le classement des affiliés par performance
   */
  async getAffiliateRanking(period = 'month') {
    let dateFilter = {};
    
    if (period === 'month') {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      dateFilter = { createdAt: { $gte: startOfMonth } };
    }

    const ranking = await Commission.aggregate([
      { $match: { status: { $in: ['pending', 'paid'] }, ...dateFilter } },
      {
        $group: {
          _id: '$affiliate',
          totalCommissions: { $sum: '$commissionAmount' },
          totalSales: { $sum: '$amount' },
          commissionsCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'affiliates',
          localField: '_id',
          foreignField: '_id',
          as: 'affiliate'
        }
      },
      { $unwind: '$affiliate' },
      {
        $project: {
          affiliateCode: '$affiliate.affiliateCode',
          firstName: '$affiliate.firstName',
          lastName: '$affiliate.lastName',
          totalCommissions: 1,
          totalSales: 1,
          commissionsCount: 1
        }
      },
      { $sort: { totalCommissions: -1 } },
      { $limit: 10 }
    ]);

    return ranking;
  }

  /**
   * Calculer les métriques d'un affilié pour une période
   */
  async calculateAffiliateMetrics(affiliateId, startDate, endDate) {
    const dateFilter = {
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      }
    };

    // Nouvelles inscriptions dans la période
    const newReferrals = await User.countDocuments({
      referredBy: affiliateId,
      ...dateFilter
    });

    // Commissions dans la période
    const commissions = await Commission.aggregate([
      {
        $match: {
          affiliate: affiliateId,
          ...dateFilter
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

    // Abonnements actifs des filleuls
    const activeSubscriptions = await Subscription.countDocuments({
      user: { 
        $in: await User.find({ referredBy: affiliateId }).distinct('_id')
      },
      status: 'active',
      endDate: { $gt: new Date() }
    });

    return {
      period: { startDate, endDate },
      newReferrals,
      activeSubscriptions,
      commissions
    };
  }
}

module.exports = new AffiliateManagementService();