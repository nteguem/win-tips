const AffiliateType = require('../../models/affiliate/AffiliateType');
const Affiliate = require('../../models/affiliate/Affiliate');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir tous les types d'affiliés
 */
exports.getAllAffiliateTypes = catchAsync(async (req, res, next) => {
  const { offset = 0, limit = 20, search } = req.query;

  // Construire les filtres
  const filters = {};
  if (search) {
    filters.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
  }

  const affiliateTypes = await AffiliateType.find(filters)
    .sort({ minAccounts: 1 }) // Trier par nombre minimum de comptes croissant
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  const total = await AffiliateType.countDocuments(filters);

  res.status(200).json({
    success: true,
    data: {
      affiliateTypes,
      pagination: {
        offset: parseInt(offset),
        limit: parseInt(limit),
        total
      }
    }
  });
});

/**
 * Obtenir un type d'affilié par ID
 */
exports.getAffiliateType = catchAsync(async (req, res, next) => {
  const affiliateType = await AffiliateType.findById(req.params.id);

  if (!affiliateType) {
    return next(new AppError('Type d\'affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Compter le nombre d'affiliés de ce type
  const affiliatesCount = await Affiliate.countDocuments({ 
    affiliateType: affiliateType._id 
  });

  res.status(200).json({
    success: true,
    data: {
      affiliateType,
      stats: {
        affiliatesCount
      }
    }
  });
});

/**
 * Créer un nouveau type d'affilié
 */
exports.createAffiliateType = catchAsync(async (req, res, next) => {
  const { name, description, minAccounts, commissionRate } = req.body;

  // Validation des champs obligatoires
  if (!name || !description || minAccounts === undefined || commissionRate === undefined) {
    return next(new AppError('Nom, description, nombre minimum de comptes et taux de commission sont requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier si le nom existe déjà
  const existingType = await AffiliateType.findOne({ name: name.toUpperCase() });
  if (existingType) {
    return next(new AppError('Ce nom de type d\'affilié existe déjà', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Créer le type d'affilié
  const affiliateType = await AffiliateType.create({
    name: name.toUpperCase(),
    description,
    minAccounts,
    commissionRate
  });

  res.status(201).json({
    success: true,
    message: 'Type d\'affilié créé avec succès',
    data: {
      affiliateType
    }
  });
});

/**
 * Modifier un type d'affilié
 */
exports.updateAffiliateType = catchAsync(async (req, res, next) => {
  const { name, description, minAccounts, commissionRate } = req.body;

  const affiliateType = await AffiliateType.findById(req.params.id);
  if (!affiliateType) {
    return next(new AppError('Type d\'affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Vérifier si le nouveau nom existe déjà (si changé)
  if (name && name.toUpperCase() !== affiliateType.name) {
    const existingType = await AffiliateType.findOne({ 
      name: name.toUpperCase(),
      _id: { $ne: req.params.id }
    });
    if (existingType) {
      return next(new AppError('Ce nom de type d\'affilié existe déjà', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  // Mettre à jour les champs autorisés
  const updateData = {};
  if (name !== undefined) updateData.name = name.toUpperCase();
  if (description !== undefined) updateData.description = description;
  if (minAccounts !== undefined) updateData.minAccounts = minAccounts;
  if (commissionRate !== undefined) updateData.commissionRate = commissionRate;

  const updatedAffiliateType = await AffiliateType.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true, runValidators: true }
  );

  res.status(200).json({
    success: true,
    message: 'Type d\'affilié mis à jour avec succès',
    data: {
      affiliateType: updatedAffiliateType
    }
  });
});

/**
 * Supprimer un type d'affilié
 */
exports.deleteAffiliateType = catchAsync(async (req, res, next) => {
  const affiliateType = await AffiliateType.findById(req.params.id);
  if (!affiliateType) {
    return next(new AppError('Type d\'affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Vérifier s'il y a des affiliés utilisant ce type
  const affiliatesCount = await Affiliate.countDocuments({
    affiliateType: req.params.id
  });

  if (affiliatesCount > 0) {
    return next(new AppError(`Impossible de supprimer ce type. ${affiliatesCount} affilié(s) l'utilisent encore`, 400, ErrorCodes.VALIDATION_ERROR));
  }

  await AffiliateType.findByIdAndDelete(req.params.id);

  res.status(200).json({
    success: true,
    message: 'Type d\'affilié supprimé avec succès'
  });
});

/**
 * Obtenir les statistiques des types d'affiliés
 */
exports.getAffiliateTypeStats = catchAsync(async (req, res, next) => {
  const totalTypes = await AffiliateType.countDocuments();
  
  // Statistiques par type
  const typeStats = await AffiliateType.aggregate([
    {
      $lookup: {
        from: 'affiliates',
        localField: '_id',
        foreignField: 'affiliateType',
        as: 'affiliates'
      }
    },
    {
      $project: {
        name: 1,
        minAccounts: 1,
        commissionRate: 1,
        affiliatesCount: { $size: '$affiliates' },
        activeAffiliatesCount: {
          $size: {
            $filter: {
              input: '$affiliates',
              as: 'affiliate',
              cond: { $eq: ['$$affiliate.isActive', true] }
            }
          }
        }
      }
    },
    {
      $sort: { minAccounts: 1 }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      totalTypes,
      typeStats
    }
  });
});

/**
 * Obtenir le type approprié pour un nombre de comptes donné
 */
exports.getTypeByAccountCount = catchAsync(async (req, res, next) => {
  const { accountCount } = req.params;

  if (!accountCount || accountCount < 0) {
    return next(new AppError('Nombre de comptes invalide', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const appropriateType = await AffiliateType.getTypeByAccountCount(parseInt(accountCount));

  if (!appropriateType) {
    return next(new AppError('Aucun type d\'affilié approprié trouvé pour ce nombre de comptes', 404, ErrorCodes.NOT_FOUND));
  }

  res.status(200).json({
    success: true,
    data: {
      accountCount: parseInt(accountCount),
      appropriateType
    }
  });
});

/**
 * Calculer la commission pour un montant donné et un type
 */
exports.calculateCommission = catchAsync(async (req, res, next) => {
  const { amount } = req.body;
  const typeId = req.params.id;

  if (!amount || amount <= 0) {
    return next(new AppError('Montant invalide', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const affiliateType = await AffiliateType.findById(typeId);
  if (!affiliateType) {
    return next(new AppError('Type d\'affilié non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  const commissionAmount = affiliateType.calculateCommission(amount);

  res.status(200).json({
    success: true,
    data: {
      originalAmount: amount,
      commissionRate: affiliateType.commissionRate,
      commissionAmount,
      affiliateType: {
        id: affiliateType._id,
        name: affiliateType.name
      }
    }
  });
});