const Affiliate = require('../../models/affiliate/Affiliate');
const authService = require('../../services/common/authService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Connexion affilié
 */
exports.login = catchAsync(async (req, res, next) => {
  const { phone, password } = req.body;
  
  // Validation des champs
  if (!phone || !password) {
    return next(new AppError('Téléphone et mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Trouver l'affilié avec le mot de passe
  const affiliate = await Affiliate.findOne({ phone }).select('+password +refreshTokens');
  
  if (!affiliate || !(await affiliate.comparePassword(password))) {
    return next(new AppError('Téléphone ou mot de passe incorrect', 401, ErrorCodes.AUTH_INVALID_CREDENTIALS));
  }
  
  // Vérifier si le compte est actif
  if (!affiliate.isActive) {
    return next(new AppError('Compte affilié désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  // Générer les tokens
  const tokens = authService.generateTokens(affiliate._id, 'affiliate');
  
  // Sauvegarder le refresh token
  affiliate.refreshTokens.push(tokens.refreshToken);
  await affiliate.save();
  
  // Réponse
  res.status(200).json(authService.formatAuthResponse(affiliate, tokens, 'Connexion affilié réussie'));
});

/**
 * Déconnexion affilié
 */
exports.logout = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (refreshToken && req.affiliate) {
    // Supprimer le refresh token spécifique
    req.affiliate.refreshTokens = req.affiliate.refreshTokens.filter(token => token !== refreshToken);
    await req.affiliate.save();
  }
  
  res.status(200).json({
    success: true,
    message: 'Déconnexion réussie'
  });
});

/**
 * Déconnexion globale (tous les appareils)
 */
exports.logoutAll = catchAsync(async (req, res, next) => {
  // Supprimer tous les refresh tokens
  req.affiliate.refreshTokens = [];
  await req.affiliate.save();
  
  res.status(200).json({
    success: true,
    message: 'Déconnexion de tous les appareils réussie'
  });
});

/**
 * Renouveler le token d'accès
 */
exports.refresh = catchAsync(async (req, res, next) => {
  // req.affiliate et req.refreshToken sont définis par le middleware verifyRefreshToken
  
  // Générer un nouveau token d'accès
  const tokens = authService.generateTokens(req.affiliate._id, 'affiliate');
  
  // Remplacer l'ancien refresh token par le nouveau
  const tokenIndex = req.affiliate.refreshTokens.indexOf(req.refreshToken);
  req.affiliate.refreshTokens[tokenIndex] = tokens.refreshToken;
  await req.affiliate.save();
  
  res.status(200).json({
    success: true,
    message: 'Token renouvelé avec succès',
    data: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    }
  });
});

/**
 * Obtenir les informations de l'affilié connecté
 */
exports.getMe = catchAsync(async (req, res, next) => {
  res.status(200).json({
    success: true,
    data: {
      affiliate: req.affiliate
    }
  });
});

/**
 * Modifier le profil de l'affilié connecté
 */
exports.updateMe = catchAsync(async (req, res, next) => {
  const { firstName, lastName, email, paymentInfo } = req.body;
  
  // Mettre à jour uniquement les champs autorisés
  const updatedAffiliate = await Affiliate.findByIdAndUpdate(
    req.affiliate._id,
    { firstName, lastName, email, paymentInfo },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    success: true,
    message: 'Profil mis à jour avec succès',
    data: {
      affiliate: updatedAffiliate
    }
  });
});

/**
 * Changer le mot de passe de l'affilié connecté
 */
exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return next(new AppError('Mot de passe actuel et nouveau mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Récupérer l'affilié avec le mot de passe
  const affiliate = await Affiliate.findById(req.affiliate._id).select('+password');
  
  // Vérifier le mot de passe actuel
  if (!(await affiliate.comparePassword(currentPassword))) {
    return next(new AppError('Mot de passe actuel incorrect', 400, ErrorCodes.AUTH_INVALID_CREDENTIALS));
  }
  
  // Mettre à jour le mot de passe
  affiliate.password = newPassword;
  await affiliate.save();
  
  res.status(200).json({
    success: true,
    message: 'Mot de passe modifié avec succès'
  });
});