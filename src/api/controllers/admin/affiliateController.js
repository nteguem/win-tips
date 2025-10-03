const Affiliate = require('../../models/affiliate/Affiliate');
const User = require('../../models/user/User');
const Commission = require('../../models/common/Commission');
const AffiliateType = require('../../models/affiliate/AffiliateType');
const commissionService = require('../../services/common/commissionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir tous les affiliés
 */
exports.getAllAffiliates = catchAsync(async (req, res, next) => {
  const { offset = 0, limit = 20, search, isActive, affiliateType } = req.query;

  // Construire les filtres
  const filters = {};
  if (search) {
    filters.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { affiliateCode: { $regex: search, $options: 'i' } }
    ];
  }
  if (isActive !== undefined) {
    filters.isActive = isActive === 'true';
  }
  if (affiliateType) {
    filters.affiliateType = affiliateType;
  }

  const affiliates = await Affiliate.find(filters)
    .populate('affiliateType', 'name commissionRate')
    .select('-password -refreshTokens')
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Affiliate.countDocuments(filters);

  res.status(200).json({
    success: true,
    data: {
      affiliates,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      }
    }
  });
});

/**
 * Obtenir un affilié par ID
 */
exports.getAffiliate = catchAsync(async (req, res, next) => {
  const affiliate = await Affiliate.findById(req.params.id)
    .populate('affiliateType')
    .select('-password -refreshTokens');

  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Obtenir statistiques de l'affilié
  const referredUsers = await User.countDocuments({ referredBy: affiliate._id });
  const pendingCommissions = await Commission.countDocuments({ 
    affiliate: affiliate._id, 
    status: 'pending' 
  });

  res.status(200).json({
    success: true,
    data: {
      affiliate,
      stats: {
        referredUsers,
        pendingCommissions
      }
    }
  });
});

/**
 * Créer un nouvel affilié
 */
exports.createAffiliate = catchAsync(async (req, res, next) => {
  const { 
    phone, 
    password, 
    firstName, 
    lastName, 
    email, 
    country, 
    city, 
    district, 
    affiliateCode,
    affiliateType
  } = req.body;

  // Validation des champs obligatoires
  if (!phone || !password || !affiliateCode) {
    return next(new AppError('Téléphone, mot de passe et code affilié sont requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier si le téléphone existe déjà
  const existingPhone = await Affiliate.findOne({ phone });
  if (existingPhone) {
    return next(new AppError('Ce numéro de téléphone est déjà utilisé', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier si le code affilié existe déjà
  const existingCode = await Affiliate.findOne({ affiliateCode: affiliateCode.toUpperCase() });
  if (existingCode) {
    return next(new AppError('Ce code affilié est déjà utilisé', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier que le type d'affilié existe (si fourni)
  if (affiliateType) {
    const typeExists = await AffiliateType.findById(affiliateType);
    if (!typeExists) {
      return next(new AppError('Type d\'affilié invalide', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  // Créer l'affilié
  const affiliate = await Affiliate.create({
    phone,
    password,
    firstName,
    lastName,
    email,
    country,
    city,
    district,
    affiliateCode: affiliateCode.toUpperCase(),
    affiliateType: affiliateType || null
  });

  // Populer le type d'affilié pour la réponse
  await affiliate.populate('affiliateType');

  res.status(201).json({
    success: true,
    message: 'Affilié créé avec succès',
    data: {
      affiliate
    }
  });
});

/**
 * Modifier un affilié
 */
exports.updateAffiliate = catchAsync(async (req, res, next) => {
  const { 
    firstName, 
    lastName, 
    email, 
    country, 
    city, 
    district,
    affiliateType,
    isActive,
    paymentInfo
  } = req.body;

  const affiliate = await Affiliate.findById(req.params.id);
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Vérifier que le type d'affilié existe (si fourni)
  if (affiliateType) {
    const typeExists = await AffiliateType.findById(affiliateType);
    if (!typeExists) {
      return next(new AppError('Type d\'affilié invalide', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  // Mettre à jour les champs autorisés
  const updateData = {};
  if (firstName !== undefined) updateData.firstName = firstName;
  if (lastName !== undefined) updateData.lastName = lastName;
  if (email !== undefined) updateData.email = email;
  if (country !== undefined) updateData.country = country;
  if (city !== undefined) updateData.city = city;
  if (district !== undefined) updateData.district = district;
  if (affiliateType !== undefined) updateData.affiliateType = affiliateType;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (paymentInfo !== undefined) updateData.paymentInfo = paymentInfo;

  const updatedAffiliate = await Affiliate.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true, runValidators: true }
  )
  .populate('affiliateType')
  .select('-password -refreshTokens');

  res.status(200).json({
    success: true,
    message: 'Affilié mis à jour avec succès',
    data: {
      affiliate: updatedAffiliate
    }
  });
});

/**
 * Supprimer (désactiver) un affilié
 */
exports.deleteAffiliate = catchAsync(async (req, res, next) => {
  const affiliate = await Affiliate.findById(req.params.id);
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Vérifier s'il y a des commissions pending
  const pendingCommissions = await Commission.countDocuments({
    affiliate: req.params.id,
    status: 'pending'
  });

  if (pendingCommissions > 0) {
    return next(new AppError('Impossible de supprimer un affilié avec des commissions en attente', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Désactiver au lieu de supprimer
  affiliate.isActive = false;
  await affiliate.save();

  res.status(200).json({
    success: true,
    message: 'Affilié désactivé avec succès'
  });
});

/**
 * Réinitialiser le mot de passe d'un affilié
 */
exports.resetPassword = catchAsync(async (req, res, next) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 6) {
    return next(new AppError('Nouveau mot de passe requis (minimum 6 caractères)', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const affiliate = await Affiliate.findById(req.params.id);
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  affiliate.password = newPassword;
  affiliate.refreshTokens = []; // Déconnexion forcée
  await affiliate.save();

  res.status(200).json({
    success: true,
    message: 'Mot de passe réinitialisé avec succès'
  });
});

/**
 * Obtenir les statistiques globales des affiliés
 */
exports.getAffiliateStats = catchAsync(async (req, res, next) => {
  const totalAffiliates = await Affiliate.countDocuments();
  const activeAffiliates = await Affiliate.countDocuments({ isActive: true });
  
  // Stats par type d'affilié
  const typeStats = await Affiliate.aggregate([
    {
      $lookup: {
        from: 'affiliatetypes',
        localField: 'affiliateType',
        foreignField: '_id',
        as: 'type'
      }
    },
    {
      $unwind: {
        path: '$type',
        preserveNullAndEmptyArrays: true
      }
    },
    {
      $group: {
        _id: '$type.name',
        count: { $sum: 1 },
        activeCount: {
          $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] }
        }
      }
    }
  ]);

  const totalCommissions = await Commission.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$commissionAmount' }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      totalAffiliates,
      activeAffiliates,
      inactiveAffiliates: totalAffiliates - activeAffiliates,
      typeStats,
      commissionStats: totalCommissions
    }
  });
});

/**
 * Obtenir toutes les commissions d'un affilié
 */
exports.getAffiliateCommissions = catchAsync(async (req, res, next) => {
  const { 
    offset = 0, 
    limit = 50, 
    status, 
    month, 
    year,
    startDate,
    endDate
  } = req.query;

  const affiliateId = req.params.id;

  // Vérifier que l'affilié existe
  const affiliate = await Affiliate.findById(affiliateId).populate('affiliateType');
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  const filters = { affiliate: affiliateId };

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
        select: 'name pricing'
      }
    })
    .sort({ createdAt: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await Commission.countDocuments(filters);

  // Stats de cet affilié
  const mongoose = require('mongoose');
  const stats = await Commission.aggregate([
    { $match: { affiliate: new mongoose.Types.ObjectId(affiliateId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$commissionAmount' }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      affiliate: {
        id: affiliate._id,
        affiliateCode: affiliate.affiliateCode,
        firstName: affiliate.firstName,
        lastName: affiliate.lastName,
        type: affiliate.affiliateType
      },
      commissions,
      stats,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      }
    }
  });
});

/**
 * Calculer (compter) les commissions pending d'un affilié spécifique
 */
exports.calculateAffiliateCommissions = catchAsync(async (req, res, next) => {
  const { month, year } = req.body;
  const affiliateId = req.params.id;

  if (!month || !year) {
    return next(new AppError('Mois et année requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier que l'affilié existe
  const affiliate = await Affiliate.findById(affiliateId);
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  const report = await commissionService.calculateAffiliateCommissions(
    affiliateId,
    parseInt(month),
    parseInt(year)
  );

  res.status(200).json({
    success: true,
    message: `Calcul des commissions pending pour ${affiliate.affiliateCode} - ${month}/${year}`,
    data: {
      affiliate: {
        id: affiliate._id,
        affiliateCode: affiliate.affiliateCode,
        firstName: affiliate.firstName,
        lastName: affiliate.lastName
      },
      report
    }
  });
});

/**
 * Obtenir les commissions en attente d'un affilié
 */
exports.getPendingAffiliateCommissions = catchAsync(async (req, res, next) => {
  const { month, year } = req.query;
  const affiliateId = req.params.id;

  if (!month || !year) {
    return next(new AppError('Mois et année requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier que l'affilié existe
  const affiliate = await Affiliate.findById(affiliateId);
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  const result = await commissionService.getPendingAffiliateCommissions(
    affiliateId,
    parseInt(month),
    parseInt(year)
  );

  res.status(200).json({
    success: true,
    data: {
      affiliate: {
        id: affiliate._id,
        affiliateCode: affiliate.affiliateCode,
        firstName: affiliate.firstName,
        lastName: affiliate.lastName
      },
      ...result
    }
  });
});

/**
 * Valider le paiement des commissions d'un affilié
 */
exports.validateAffiliatePayment = catchAsync(async (req, res, next) => {
  const { month, year, paymentReference } = req.body;
  const affiliateId = req.params.id;

  if (!month || !year || !paymentReference) {
    return next(new AppError('Mois, année et référence de paiement requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier que l'affilié existe
  const affiliate = await Affiliate.findById(affiliateId);
  if (!affiliate) {
    return next(new AppError('Affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  const report = await commissionService.validateAffiliatePayment(
    affiliateId,
    parseInt(month),
    parseInt(year),
    paymentReference
  );

  res.status(200).json({
    success: true,
    message: `Paiement validé pour ${affiliate.affiliateCode} - ${report.paidCommissions} commissions`,
    data: {
      affiliate: {
        id: affiliate._id,
        affiliateCode: affiliate.affiliateCode,
        firstName: affiliate.firstName,
        lastName: affiliate.lastName
      },
      report
    }
  });
});