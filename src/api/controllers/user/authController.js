const User = require('../../models/user/User');
const authService = require('../../services/common/authService');
const subscriptionService = require('../../services/user/subscriptionService');
const deviceService = require('../../services/common/deviceService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Inscription utilisateur avec génération automatique d'email
 */
exports.register = catchAsync(async (req, res, next) => {
  const { phoneNumber, countryCode, dialCode, password, pseudo, affiliateCode, city, deviceId } = req.body;

  // Validation des champs obligatoires
  if (!phoneNumber || !password) {
    return next(new AppError('Téléphone et mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Vérifier si le numéro existe déjà
  const existingUser = await User.findOne({ phoneNumber });
  if (existingUser) {
    return next(new AppError('Ce numéro de téléphone est déjà utilisé', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Valider le code affilié si fourni
  let affiliate = null;
  if (affiliateCode) {
    try {
      affiliate = await authService.validateAffiliateCode(affiliateCode);
    } catch (error) {
      return next(error);
    }
  }
  
  // Générer l'email automatiquement avec vérification d'unicité
  const generatedEmail = await generateUniqueUserEmail(phoneNumber, pseudo, countryCode);
  
  // Créer l'utilisateur
  const user = await User.create({
    phoneNumber,
    email: generatedEmail,
    password,
    pseudo,
    dialCode,
    countryCode,
    city,
    referredBy: affiliate?._id
  });
  
  // Générer les tokens
  const tokens = authService.generateTokens(user._id, 'user');
  
  // Sauvegarder le refresh token
  user.refreshTokens.push(tokens.refreshToken);
  await user.save();
  
  // Lier le device au user
  let device = null;
  if (deviceId) {
    try {
      device = await deviceService.linkDeviceToUser(deviceId, user._id);
    } catch (error) {
      console.error('Erreur linkage device:', error);
    }
  }
  
  // Vérifier s'il a un abonnement actif (normalement false pour un nouveau user)
  const subscriptionInfo = await subscriptionService.getUserSubscriptionInfo(user._id);
  
  // Réponse avec l'info d'abonnement et device
  const response = authService.formatAuthResponse(user, tokens, 'Inscription réussie');
  response.data.hasActiveSubscription = subscriptionInfo.hasActiveSubscription;
  response.data.activePackages = subscriptionInfo.activePackages;
  response.data.device = device;
  
  res.status(201).json(response);
});

// Fonction pour générer automatiquement un email utilisateur avec vérification d'unicité
async function generateUniqueUserEmail(phoneNumber, pseudo, countryCode) {
  const cleanPhone = phoneNumber.replace(/[^\d]/g, '');
  const domain = "wintips.com";
  let baseEmail = `user${cleanPhone}@${domain}`;
  let finalEmail = baseEmail;
  let counter = 1;
  
  // Vérifier l'unicité
  while (await User.findOne({ email: finalEmail })) {
    finalEmail = `user${cleanPhone}${counter}@${domain}`;
    counter++;
  }
  
  return finalEmail;
}

/**
 * Connexion utilisateur
 */
exports.login = catchAsync(async (req, res, next) => {
  const { phoneNumber, password, deviceId } = req.body;
  
  // Validation des champs
  if (!phoneNumber || !password) {
    return next(new AppError('Téléphone et mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Trouver l'utilisateur avec le mot de passe
  const user = await User.findOne({ phoneNumber }).select('+password +refreshTokens');
  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError('Téléphone ou mot de passe incorrect', 401, ErrorCodes.AUTH_INVALID_CREDENTIALS));
  }
  
  // Vérifier si le compte est actif
  if (!user.isActive) {
    return next(new AppError('Compte utilisateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  // Générer les tokens
  const tokens = authService.generateTokens(user._id, 'user');
  
  // Sauvegarder le refresh token
  user.refreshTokens.push(tokens.refreshToken);
  await user.save();
  
  // Lier le device au user
  let device = null;
  if (deviceId) {
    try {
      device = await deviceService.linkDeviceToUser(deviceId, user._id);
    } catch (error) {
      console.error('Erreur linkage device:', error);
    }
  }
  
  // Vérifier s'il a un abonnement actif
  const subscriptionInfo = await subscriptionService.getUserSubscriptionInfo(user._id);
  
  // Réponse avec l'info d'abonnement et device
  const response = authService.formatAuthResponse(user, tokens, 'Connexion réussie');
  response.data.hasActiveSubscription = subscriptionInfo.hasActiveSubscription;
  response.data.activePackages = subscriptionInfo.activePackages;
  response.data.device = device;
  
  console.log("user", user);
  console.log("response", response);

  res.status(200).json(response);
});

/**
 * Déconnexion utilisateur
 */
exports.logout = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (refreshToken && req.user) {
    // Supprimer le refresh token spécifique
    req.user.refreshTokens = req.user.refreshTokens.filter(token => token !== refreshToken);
    await req.user.save();
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
  req.user.refreshTokens = [];
  await req.user.save();
  
  res.status(200).json({
    success: true,
    message: 'Déconnexion de tous les appareils réussie'
  });
});

/**
 * Renouveler le token d'accès
 */
exports.refresh = catchAsync(async (req, res, next) => {
  // req.user et req.refreshToken sont définis par le middleware verifyRefreshToken
  
  // Générer un nouveau token d'accès
  const tokens = authService.generateTokens(req.user._id, 'user');
  
  // Remplacer l'ancien refresh token par le nouveau
  const tokenIndex = req.user.refreshTokens.indexOf(req.refreshToken);
  req.user.refreshTokens[tokenIndex] = tokens.refreshToken;
  await req.user.save();
  
  // Vérifier s'il a un abonnement actif lors du refresh
  const subscriptionInfo = await subscriptionService.getUserSubscriptionInfo(req.user._id);
  
  res.status(200).json({
    success: true,
    message: 'Token renouvelé avec succès',
    data: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      hasActiveSubscription: subscriptionInfo.hasActiveSubscription,
      activePackages: subscriptionInfo.activePackages
    }
  });
});

/**
 * Obtenir les informations de l'utilisateur connecté
 */
exports.getMe = catchAsync(async (req, res, next) => {
  // Populer les infos de l'affilié parrain si existant
  const user = await User.findById(req.user._id).populate('referredBy', 'firstName lastName affiliateCode');
  
  // Vérifier s'il a un abonnement actif
  const subscriptionInfo = await subscriptionService.getUserSubscriptionInfo(req.user._id);
  
  res.status(200).json({
    success: true,
    data: {
      user,
      hasActiveSubscription: subscriptionInfo.hasActiveSubscription,
      activePackages: subscriptionInfo.activePackages
    }
  });
});

/**
 * Modifier le profil de l'utilisateur connecté
 */
exports.updateMe = catchAsync(async (req, res, next) => {
  const { firstName, lastName, email } = req.body;
  
  // Mettre à jour uniquement les champs autorisés
  const updatedUser = await User.findByIdAndUpdate(
    req.user._id,
    { firstName, lastName, email },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    success: true,
    message: 'Profil mis à jour avec succès',
    data: {
      user: updatedUser
    }
  });
});

/**
 * Changer le mot de passe de l'utilisateur connecté
 */
exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return next(new AppError('Mot de passe actuel et nouveau mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Récupérer l'utilisateur avec le mot de passe
  const user = await User.findById(req.user._id).select('+password');
  
  // Vérifier le mot de passe actuel
  if (!(await user.comparePassword(currentPassword))) {
    return next(new AppError('Mot de passe actuel incorrect', 400, ErrorCodes.AUTH_INVALID_CREDENTIALS));
  }
  
  // Mettre à jour le mot de passe
  user.password = newPassword;
  await user.save();
  
  res.status(200).json({
    success: true,
    message: 'Mot de passe modifié avec succès'
  });
});

/**
 * Réinitialisation du mot de passe utilisateur
 */
exports.resetPassword = catchAsync(async (req, res, next) => {
  const { phoneNumber, pseudo, newPassword } = req.body;

  // Validation des champs obligatoires
  if (!phoneNumber || !pseudo || !newPassword) {
    return next(new AppError('Téléphone, pseudo et nouveau mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Validation longueur mot de passe
  if (newPassword.length < 6) {
    return next(new AppError('Le mot de passe doit contenir au moins 6 caractères', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Trouver l'utilisateur avec phoneNumber ET pseudo
  const user = await User.findOne({ 
    phoneNumber, 
    pseudo 
  });

  if (!user) {
    return next(new AppError('Aucun compte trouvé avec ce numéro de téléphone et ce pseudo', 404, ErrorCodes.AUTH_USER_NOT_FOUND));
  }

  // Vérifier si le compte est actif
  if (!user.isActive) {
    return next(new AppError('Compte utilisateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }

  // Mettre à jour le mot de passe
  user.password = newPassword;
  
  // Invalider tous les refresh tokens existants pour forcer une nouvelle connexion
  user.refreshTokens = [];
  
  await user.save();

  res.status(200).json({
    success: true,
    message: 'Mot de passe réinitialisé avec succès. Veuillez vous reconnecter.'
  });
});