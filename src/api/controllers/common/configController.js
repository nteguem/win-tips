/**
 * @fileoverview Controller de gestion de la configuration par pays
 * Gère les endpoints publics et admin
 */
const configService = require('../../services/common/configService');
const catchAsync = require('../../../utils/catchAsync');
const AppError = require('../../../utils/AppError');
const { formatSuccess } = require('../../../utils/responseFormatter');

/**
 * @route POST /api/config
 * @desc Obtenir la configuration par IP
 * @access Public
 */
exports.getConfigByIp = catchAsync(async (req, res, next) => {
  const { ipAddress } = req.body;

  // Validation de l'IP
  if (!ipAddress) {
    return next(new AppError('L\'adresse IP est requise', 400));
  }

  // Récupérer la configuration
  const config = await configService.getConfigByIp(ipAddress);

  formatSuccess(res, {
    message: 'Configuration récupérée avec succès',
    data: config
  });
});

/**
 * @route GET /api/config/:countryCode
 * @desc Obtenir la configuration par code pays
 * @access Public
 */
exports.getConfigByCountryCode = catchAsync(async (req, res, next) => {
  const { countryCode } = req.params;

  // Validation du code pays
  if (!countryCode || countryCode.length !== 2) {
    return next(new AppError('Code pays invalide (2 lettres requis)', 400));
  }

  // Récupérer la configuration
  const config = await configService.getConfigByCountryCode(countryCode);

  formatSuccess(res, {
    message: 'Configuration récupérée avec succès',
    data: config
  });
});


/**
 * @route GET /admin/config
 * @desc Obtenir toutes les configurations
 * @access Admin
 */
exports.getAllConfigs = catchAsync(async (req, res, next) => {
  const configs = await configService.getAllConfigs();

  formatSuccess(res, {
    message: 'Configurations récupérées avec succès',
    data: {
      total: configs.length,
      configs,
    }
  });
});

/**
 * @route POST /admin/config
 * @desc Créer une nouvelle configuration
 * @access Admin
 */
exports.createConfig = catchAsync(async (req, res, next) => {
  const {
    countryCode,
    countryName,
    currency,
    language,
    phonePrefix,
    paymentProvider,
    isActive,
    metadata,
  } = req.body;

  // Validation des champs requis
  if (!countryCode || !countryName || !currency || !language || !phonePrefix || !paymentProvider) {
    return next(
      new AppError(
        'Tous les champs requis doivent être fournis (countryCode, countryName, currency, language, phonePrefix, paymentProvider)',
        400
      )
    );
  }

  // Créer ou mettre à jour la configuration
  const config = await configService.upsertConfig(countryCode, {
    countryName,
    currency,
    language,
    phonePrefix,
    paymentProvider,
    isActive: isActive !== undefined ? isActive : true,
    metadata: metadata || {},
  });

  formatSuccess(res, {
    message: 'Configuration créée avec succès',
    data: config,
    statusCode: 201
  });
});

/**
 * @route PUT /admin/config/:countryCode
 * @desc Mettre à jour une configuration
 * @access Admin
 */
exports.updateConfig = catchAsync(async (req, res, next) => {
  const { countryCode } = req.params;
  const updateData = req.body;

  // Ne pas permettre de modifier le countryCode
  delete updateData.countryCode;

  // Mettre à jour la configuration
  const config = await configService.upsertConfig(countryCode, updateData);

  formatSuccess(res, {
    message: 'Configuration mise à jour avec succès',
    data: config
  });
});

/**
 * @route DELETE /admin/config/:countryCode
 * @desc Supprimer une configuration
 * @access Admin
 */
exports.deleteConfig = catchAsync(async (req, res, next) => {
  const { countryCode } = req.params;

  await configService.deleteConfig(countryCode);

  formatSuccess(res, {
    message: 'Configuration supprimée avec succès',
    data: null
  });
});

/**
 * @route PATCH /admin/config/:countryCode/toggle
 * @desc Activer/désactiver un pays
 * @access Admin
 */
exports.toggleCountry = catchAsync(async (req, res, next) => {
  const { countryCode } = req.params;
  const { isActive } = req.body;

  // Validation
  if (typeof isActive !== 'boolean') {
    return next(new AppError('Le champ isActive doit être un booléen', 400));
  }

  const config = await configService.toggleCountry(countryCode, isActive);

  formatSuccess(res, {
    message: `Pays ${isActive ? 'activé' : 'désactivé'} avec succès`,
    data: config
  });
});

/**
 * @route POST /admin/config/cache/clear
 * @desc Vider les caches (debug/maintenance)
 * @access Admin
 */
exports.clearCache = catchAsync(async (req, res, next) => {
  configService.clearCache();

  formatSuccess(res, {
    message: 'Caches vidés avec succès',
    data: null
  });
});