const subscriptionService = require('../../services/user/subscriptionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Acheter un package (créer un abonnement)
 */
exports.purchasePackage = catchAsync(async (req, res, next) => {
  const { packageId, currency = 'XAF', paymentReference } = req.body;

  if (!packageId) {
    return next(new AppError('ID du package requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier si l'utilisateur a déjà un abonnement actif pour ce package
  const activeSubscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
  const hasActivePackage = activeSubscriptions.some(sub => 
    sub.package._id.toString() === packageId
  );

  if (hasActivePackage) {
    return next(new AppError('Vous avez déjà un abonnement actif pour ce package', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Créer l'abonnement
  const subscription = await subscriptionService.createSubscription(
    req.user._id,
    packageId,
    currency,
    paymentReference
  );

  // Populer les données pour la réponse
  await subscription.populate('package');

  res.status(201).json({
    success: true,
    message: 'Abonnement activé avec succès',
    data: {
      subscription
    }
  });
});

/**
 * Obtenir tous les abonnements de l'utilisateur
 */
exports.getMySubscriptions = catchAsync(async (req, res, next) => {
  const subscriptions = await subscriptionService.getUserSubscriptions(req.user._id);

  res.status(200).json({
    success: true,
    data: {
      subscriptions,
      count: subscriptions.length
    }
  });
});

/**
 * Obtenir les abonnements actifs de l'utilisateur
 */
exports.getMyActiveSubscriptions = catchAsync(async (req, res, next) => {
  const subscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);

  res.status(200).json({
    success: true,
    data: {
      subscriptions,
      count: subscriptions.length
    }
  });
});

/**
 * Obtenir un abonnement spécifique
 */
exports.getSubscription = catchAsync(async (req, res, next) => {
  const Subscription = require('../../models/user/Subscription');
  
  const subscription = await Subscription.findOne({
    _id: req.params.id,
    user: req.user._id
  }).populate('package');

  if (!subscription) {
    return next(new AppError('Abonnement non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  res.status(200).json({
    success: true,
    data: {
      subscription
    }
  });
});

/**
 * Vérifier l'accès à une catégorie
 */
exports.checkCategoryAccess = catchAsync(async (req, res, next) => {
  const { categoryId } = req.params;

  const hasAccess = await subscriptionService.hasAccessToCategory(req.user._id, categoryId);

  res.status(200).json({
    success: true,
    data: {
      categoryId,
      hasAccess,
      message: hasAccess ? 'Accès autorisé' : 'Abonnement requis'
    }
  });
});

/**
 * Obtenir le statut d'abonnement détaillé
 */
exports.getSubscriptionStatus = catchAsync(async (req, res, next) => {
  const activeSubscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);

  // Récupérer toutes les catégories accessibles
  const accessibleCategories = [];
  for (const subscription of activeSubscriptions) {
    accessibleCategories.push(...subscription.package.categories);
  }

  // Supprimer les doublons
  const uniqueCategories = [...new Set(accessibleCategories.map(cat => cat._id.toString()))]
    .map(id => accessibleCategories.find(cat => cat._id.toString() === id));

  res.status(200).json({
    success: true,
    data: {
      hasActiveSubscription: activeSubscriptions.length > 0,
      activeSubscriptions,
      accessibleCategories: uniqueCategories,
      subscriptionCount: activeSubscriptions.length
    }
  });
});

/**
 * Obtenir l'historique des abonnements
 */
exports.getSubscriptionHistory = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;
  const Subscription = require('../../models/user/Subscription');

  const skip = (page - 1) * limit;
  
  const subscriptions = await Subscription.find({ user: req.user._id })
    .populate('package', 'name pricing duration')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const total = await Subscription.countDocuments({ user: req.user._id });

  res.status(200).json({
    success: true,
    data: {
      subscriptions,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    }
  });
});