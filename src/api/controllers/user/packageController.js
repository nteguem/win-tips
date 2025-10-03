const Package = require('../../models/common/Package');
const subscriptionService = require('../../services/user/subscriptionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Obtenir tous les packages disponibles (user)
 */
exports.getAvailablePackages = catchAsync(async (req, res, next) => {
  const { currency, lang = 'fr' } = req.query;  
  const packages = await Package.find({ isActive: true })
    .populate('categories', 'name description isVip')
    .populate('formationId');

  // Trier manuellement par prix dans la devise demandée
  const sortedPackages = packages.sort((a, b) => {
    const priceA = a.getPricing(currency || 'XAF') || 0;
    const priceB = b.getPricing(currency || 'XAF') || 0;
    return priceA - priceB;
  });

  let result = sortedPackages.map(pkg => pkg.formatForLanguage(lang));
  
  if (currency) {    
    // Filtrer d'abord les packages qui ont la devise
    const packagesWithCurrency = result.filter(pkg => {
      return pkg.pricing && pkg.pricing[currency] !== undefined;
    });
      
    // Puis transformer pour ne garder que la devise demandée
    result = packagesWithCurrency.map(pkg => {
      const packageData = { ...pkg };
      packageData.pricing = { [currency]: pkg.pricing[currency] };
      packageData.economy = pkg.economy ? { [currency]: pkg.economy[currency] } : null;
      return packageData;
    });
  }

  res.status(200).json({
    success: true,
    data: {
      packages: result,
      count: result.length,
      ...(currency && { currency })
    }
  });
});

/**
 * Obtenir un package spécifique
 */
exports.getPackage = catchAsync(async (req, res, next) => {
  const { currency, lang = 'fr' } = req.query;
  
  const package = await Package.findOne({ 
    _id: req.params.id, 
    isActive: true 
  }).populate('categories', 'name description isVip')
    .populate('formationId');

  if (!package) {
    return next(new AppError('Package non trouvé ou non disponible', 404, ErrorCodes.NOT_FOUND));
  }

  // Vérifier si l'utilisateur a déjà ce package (optionnel)
  let userHasPackage = false;
  if (req.user) {
    const activeSubscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
    userHasPackage = activeSubscriptions.some(sub => 
      sub.package._id.toString() === package._id.toString()
    );
  }

  // Traitement du package selon la devise
  let processedPackage = package.formatForLanguage(lang);
  
  if (currency) {
    // Si le package n'a pas la devise demandée, retourner une erreur
    if (!processedPackage.pricing || !processedPackage.pricing[currency]) {
      return next(new AppError(`Package non disponible dans la devise ${currency}`, 404, ErrorCodes.NOT_FOUND));
    }
    
    processedPackage.pricing = { [currency]: processedPackage.pricing[currency] };
    processedPackage.economy = processedPackage.economy ? { [currency]: processedPackage.economy[currency] } : null;
  }

  res.status(200).json({
    success: true,
    data: {
      package: processedPackage,
      userHasPackage,
      ...(currency && { currency })
    }
  });
});

/**
 * Obtenir les packages par catégorie
 */
exports.getPackagesByCategory = catchAsync(async (req, res, next) => {
  const { categoryId } = req.params;
  const { currency, lang = 'fr' } = req.query;

  const packages = await Package.find({ 
    isActive: true,
    categories: categoryId
  }).populate('categories', 'name description isVip')
    .populate('formationId');

  // Trier manuellement par prix dans la devise demandée
  const sortedPackages = packages.sort((a, b) => {
    const priceA = a.getPricing(currency || 'XAF') || 0;
    const priceB = b.getPricing(currency || 'XAF') || 0;
    return priceA - priceB;
  });

  // Traitement des packages selon la devise
  let processedPackages = sortedPackages.map(pkg => pkg.formatForLanguage(lang));
  
  if (currency) {
    processedPackages = processedPackages
      .filter(pkg => pkg.pricing && pkg.pricing[currency]) // Filtrer seulement les packages qui ont la devise
      .map(pkg => {
        const packageData = { ...pkg };
        packageData.pricing = { [currency]: pkg.pricing[currency] };
        packageData.economy = pkg.economy ? { [currency]: pkg.economy[currency] } : null;
        return packageData;
      });
  }

  res.status(200).json({
    success: true,
    data: {
      packages: processedPackages,
      count: processedPackages.length,
      ...(currency && { currency })
    }
  });
});