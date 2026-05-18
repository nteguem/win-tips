const Package = require('../../models/common/Package');
const Formation = require('../../models/common/Formation');
const Category = require('../../models/common/Category');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir tous les packages (admin)
 */
exports.getAllPackages = catchAsync(async (req, res, next) => {
  const { lang = 'fr', currency = 'XAF' } = req.query;
  
  // Récupération de tous les packages
  const packages = await Package.find()
    .populate('categories', 'name description isVip')
    .populate('formationId');

  // FILTRER uniquement les packages qui ont la devise demandée
  const packagesWithCurrency = packages.filter(pkg => {
    const price = pkg.getPricing(currency);
    return price !== null && price !== undefined;
  });

  // Si aucun package n'a cette devise, retourner vide
  if (!packagesWithCurrency.length) {
    return res.status(200).json({
      success: true,
      data: {
        packages: [],
        count: 0,
        currency: currency
      }
    });
  }

  // Trier par prix dans la devise demandée
  const sortedPackages = packagesWithCurrency.sort((a, b) => {
    const priceA = a.getPricing(currency) || 0;
    const priceB = b.getPricing(currency) || 0;
    return priceA - priceB;
  });

  // Formater selon la langue ET filtrer par devise
  const formattedPackages = sortedPackages.map(pkg => {
    const formatted = pkg.formatForLanguage(lang);
    
    formatted.pricing = formatted.pricing[currency] || 0;
    formatted.economy = formatted.economy ? (formatted.economy[currency] || 0) : null;
    
    return formatted;
  });

  res.status(200).json({
    success: true,
    data: {
      packages: formattedPackages,
      count: formattedPackages.length,
      currency: currency
    }
  });
});
/**
 * Obtenir un package par ID
 */
exports.getPackage = catchAsync(async (req, res, next) => {
  const { lang = 'fr' } = req.query;
  
  const package = await Package.findById(req.params.id)
    .populate('categories', 'name description isVip')
    .populate('formationId');

  if (!package) {
    return next(new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  const formattedPackage = package.formatForLanguage(lang);

  res.status(200).json({
    success: true,
    data: {
      package: formattedPackage
    }
  });
});

/**
 * Créer un nouveau package
 */
exports.createPackage = catchAsync(async (req, res, next) => {
  const {
    name, description, pricing, duration, categories, badge, economy, formationId,
    paymentMode, adsRequired,
  } = req.body;

  // Validation : la nature des champs requis dépend du mode de paiement.
  //   money (défaut) : pricing.XAF requis
  //   ads            : adsRequired >= 1 requis ; pricing peut être absent
  const mode = paymentMode || 'money';
  if (!name?.fr || !name?.en || !duration) {
    return next(new AppError('Nom (FR/EN) et durée sont requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  if (mode === 'money' && !pricing?.XAF) {
    return next(new AppError('Prix en XAF requis pour un pack en mode argent', 400, ErrorCodes.VALIDATION_ERROR));
  }
  if (mode === 'ads' && (!adsRequired || adsRequired < 1)) {
    return next(new AppError('adsRequired >= 1 requis pour un pack en mode pubs', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Vérifier que les catégories existent
  if (categories && categories.length > 0) {
    const existingCategories = await Category.find({ _id: { $in: categories } });
    if (existingCategories.length !== categories.length) {
      return next(new AppError('Une ou plusieurs catégories sont invalides', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  // Vérifier que la formation existe si fournie
  if (formationId) {
    const existingFormation = await Formation.findById(formationId);
    if (!existingFormation) {
      return next(new AppError('Formation invalide', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  const package = await Package.create({
    name,
    description,
    pricing: mode === 'ads' ? undefined : pricing,
    duration,
    categories: categories || [],
    badge,
    economy: mode === 'ads' ? undefined : economy,
    formationId,
    paymentMode: mode,
    adsRequired: mode === 'ads' ? adsRequired : null,
  });

  // Populer les relations pour la réponse
  await package.populate('categories', 'name isVip');
  await package.populate('formationId');

  res.status(201).json({
    success: true,
    message: 'Package créé avec succès',
    data: {
      package
    }
  });
});

/**
 * Modifier un package
 */
exports.updatePackage = catchAsync(async (req, res, next) => {
  const {
    name, description, pricing, duration, categories, badge, economy, formationId, isActive,
    paymentMode, adsRequired,
  } = req.body;

  // Vérifier que le package existe
  let package = await Package.findById(req.params.id);
  if (!package) {
    return next(new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Vérifier les catégories si fournies
  if (categories && categories.length > 0) {
    const existingCategories = await Category.find({ _id: { $in: categories } });
    if (existingCategories.length !== categories.length) {
      return next(new AppError('Une ou plusieurs catégories sont invalides', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  // Vérifier la formation si fournie
  if (formationId) {
    const existingFormation = await Formation.findById(formationId);
    if (!existingFormation) {
      return next(new AppError('Formation invalide', 400, ErrorCodes.VALIDATION_ERROR));
    }
  }

  // Mettre à jour les champs.
  // IMPORTANT : pour que le pre-save Mongoose (mutex paymentMode ↔ champs)
  // s'exécute correctement, on assigne sur l'instance et on appelle save()
  // plutôt que findByIdAndUpdate avec pipeline brut.
  if (name !== undefined) package.name = name;
  if (description !== undefined) package.description = description;
  if (duration !== undefined) package.duration = duration;
  if (categories !== undefined) package.categories = categories;
  if (badge !== undefined) package.badge = badge;
  if (formationId !== undefined) package.formationId = formationId;
  if (isActive !== undefined) package.isActive = isActive;

  // Mode de paiement + champs liés. Si le mode change, le pre-save efface
  // automatiquement pricing/economy/adsRequired non-pertinents.
  if (paymentMode !== undefined) package.paymentMode = paymentMode;
  const effectiveMode = package.paymentMode || 'money';

  if (effectiveMode === 'ads') {
    // En mode ads : seul adsRequired compte
    if (adsRequired !== undefined) package.adsRequired = adsRequired;
    package.pricing = undefined;
    package.economy = undefined;
  } else {
    // En mode money : pricing + economy, pas d'adsRequired
    if (pricing !== undefined) package.pricing = pricing;
    if (economy !== undefined) package.economy = economy;
    package.adsRequired = null;
  }

  await package.save();
  await package.populate('categories', 'name isVip');
  await package.populate('formationId');

  res.status(200).json({
    success: true,
    message: 'Package mis à jour avec succès',
    data: {
      package
    }
  });
});

/**
 * Supprimer un package
 */
exports.deletePackage = catchAsync(async (req, res, next) => {
  const package = await Package.findById(req.params.id);

  if (!package) {
    return next(new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  await Package.findByIdAndDelete(req.params.id);

  res.status(200).json({
    success: true,
    message: 'Package supprimé avec succès'
  });
});

/**
 * Activer/désactiver un package
 */
exports.togglePackageStatus = catchAsync(async (req, res, next) => {
  const package = await Package.findById(req.params.id);

  if (!package) {
    return next(new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  package.isActive = !package.isActive;
  await package.save();

  res.status(200).json({
    success: true,
    message: `Package ${package.isActive ? 'activé' : 'désactivé'} avec succès`,
    data: {
      package
    }
  });
});

/**
 * Obtenir les statistiques des packages
 */
exports.getPackageStats = catchAsync(async (req, res, next) => {
  const stats = await Package.aggregate([
    {
      $group: {
        _id: '$isActive',
        count: { $sum: 1 },
        avgPrice: { $avg: '$pricing.XAF' }
      }
    }
  ]);

  const totalPackages = await Package.countDocuments();
  
  res.status(200).json({
    success: true,
    data: {
      totalPackages,
      stats
    }
  });
});