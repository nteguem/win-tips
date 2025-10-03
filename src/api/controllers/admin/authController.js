const Admin = require('../../models/admin/Admin');
const authService = require('../../services/common/authService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Connexion admin
 */
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  
  // Validation des champs
  if (!email || !password) {
    return next(new AppError('Email et mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Trouver l'admin avec le mot de passe
  const admin = await Admin.findOne({ email: email.toLowerCase() }).select('+password +refreshTokens');
  
  if (!admin || !(await admin.comparePassword(password))) {
    return next(new AppError('Email ou mot de passe incorrect', 401, ErrorCodes.AUTH_INVALID_CREDENTIALS));
  }
  
  // Vérifier si le compte est actif
  if (!admin.isActive) {
    return next(new AppError('Compte administrateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  // Générer les tokens
  const tokens = authService.generateTokens(admin._id, 'admin');
  
  // Sauvegarder le refresh token
  admin.refreshTokens.push(tokens.refreshToken);
  admin.lastLogin = new Date();
  await admin.save();
  
  // Réponse
  res.status(200).json(authService.formatAuthResponse(admin, tokens, 'Connexion admin réussie'));
});

/**
 * Inscription admin
 */
exports.register = catchAsync(async (req, res, next) => {
  const { email, password, firstName, lastName, phone } = req.body;
  
  // Validation des champs obligatoires
  if (!email || !password) {
    return next(new AppError('Email et mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Vérifier si l'admin existe déjà
  const existingAdmin = await Admin.findOne({ email: email.toLowerCase() });
  if (existingAdmin) {
    return next(new AppError('Un administrateur avec cet email existe déjà', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Créer le nouvel admin
  const admin = await Admin.create({
    email: email.toLowerCase(),
    password,
    firstName,
    lastName,
    phone,
    isActive: true, // ou false si vous voulez une validation manuelle
    role: 'admin' // Définir le rôle par défaut
  });
  
  // Générer les tokens
  const tokens = authService.generateTokens(admin._id, 'admin');
  
  // Sauvegarder le refresh token
  admin.refreshTokens.push(tokens.refreshToken);
  admin.lastLogin = new Date();
  await admin.save();
  
  // Réponse
  res.status(201).json(authService.formatAuthResponse(admin, tokens, 'Inscription admin réussie'));
});
/**
 * Déconnexion admin
 */
exports.logout = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (refreshToken && req.admin) {
    // Supprimer le refresh token spécifique
    req.admin.refreshTokens = req.admin.refreshTokens.filter(token => token !== refreshToken);
    await req.admin.save();
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
  req.admin.refreshTokens = [];
  await req.admin.save();
  
  res.status(200).json({
    success: true,
    message: 'Déconnexion de tous les appareils réussie'
  });
});

/**
 * Renouveler le token d'accès
 */
exports.refresh = catchAsync(async (req, res, next) => {
  // req.admin et req.refreshToken sont définis par le middleware verifyRefreshToken
  
  // Générer un nouveau token d'accès
  const tokens = authService.generateTokens(req.admin._id, 'admin');
  
  // Remplacer l'ancien refresh token par le nouveau
  const tokenIndex = req.admin.refreshTokens.indexOf(req.refreshToken);
  req.admin.refreshTokens[tokenIndex] = tokens.refreshToken;
  await req.admin.save();
  
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
 * Obtenir les informations de l'admin connecté
 */
exports.getMe = catchAsync(async (req, res, next) => {
  res.status(200).json({
    success: true,
    data: {
      admin: req.admin
    }
  });
});

/**
 * Modifier le profil de l'admin connecté
 */
exports.updateMe = catchAsync(async (req, res, next) => {
  const { firstName, lastName, phone } = req.body;
  
  // Mettre à jour uniquement les champs autorisés
  const updatedAdmin = await Admin.findByIdAndUpdate(
    req.admin._id,
    { firstName, lastName, phone },
    { new: true, runValidators: true }
  );
  
  res.status(200).json({
    success: true,
    message: 'Profil mis à jour avec succès',
    data: {
      admin: updatedAdmin
    }
  });
});

/**
 * Changer le mot de passe de l'admin connecté
 */
exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return next(new AppError('Mot de passe actuel et nouveau mot de passe requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  // Récupérer l'admin avec le mot de passe
  const admin = await Admin.findById(req.admin._id).select('+password');
  
  // Vérifier le mot de passe actuel
  if (!(await admin.comparePassword(currentPassword))) {
    return next(new AppError('Mot de passe actuel incorrect', 400, ErrorCodes.AUTH_INVALID_CREDENTIALS));
  }
  
  // Mettre à jour le mot de passe
  admin.password = newPassword;
  await admin.save();
  
  res.status(200).json({
    success: true,
    message: 'Mot de passe modifié avec succès'
  });
});