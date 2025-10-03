const User = require('../../models/user/User');
const authService = require('../../services/common/authService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Middleware de protection des routes user
 */
exports.protect = catchAsync(async (req, res, next) => {
  // 1. Extraire le token
  const authHeader = req.headers.authorization;
  let token;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  
  if (!token) {
    return next(new AppError('Token d\'authentification requis', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }
  
  // 2. Vérifier le token
  const decoded = authService.verifyToken(token, 'user');
  
  // 3. Vérifier si l'utilisateur existe encore
  const user = await User.findById(decoded.id);
  if (!user) {
    return next(new AppError('L\'utilisateur n\'existe plus', 401, ErrorCodes.AUTH_USER_NOT_FOUND));
  }
  
  // 4. Vérifier si l'utilisateur est actif
  if (!user.isActive) {
    return next(new AppError('Compte utilisateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  // 5. Attacher l'utilisateur à la requête
  req.user = user;
  next();
});

/**
 * Middleware pour vérifier les refresh tokens user
 */
exports.verifyRefreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return next(new AppError('Refresh token requis', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }
  
  // Vérifier le refresh token
  const decoded = authService.verifyRefreshToken(refreshToken);
  
  if (decoded.type !== 'user') {
    return next(new AppError('Type de token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN));
  }
  
  // Vérifier si l'utilisateur existe et possède ce refresh token
  const user = await User.findById(decoded.id).select('+refreshTokens');
  
  if (!user || !user.refreshTokens.includes(refreshToken)) {
    return next(new AppError('Refresh token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN));
  }
  
  if (!user.isActive) {
    return next(new AppError('Compte utilisateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  req.user = user;
  req.refreshToken = refreshToken;
  next();
});