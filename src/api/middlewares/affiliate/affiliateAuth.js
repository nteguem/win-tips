const Affiliate = require('../../models/affiliate/Affiliate');
const authService = require('../../services/common/authService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Middleware de protection des routes affiliate
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
  const decoded = authService.verifyToken(token, 'affiliate');
  
  // 3. Vérifier si l'affilié existe encore
  const affiliate = await Affiliate.findById(decoded.id);
  if (!affiliate) {
    return next(new AppError('L\'affilié n\'existe plus', 401, ErrorCodes.AUTH_USER_NOT_FOUND));
  }
  
  // 4. Vérifier si l'affilié est actif
  if (!affiliate.isActive) {
    return next(new AppError('Compte affilié désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  // 5. Attacher l'affilié à la requête
  req.affiliate = affiliate;
  next();
});

/**
 * Middleware pour vérifier les refresh tokens affilié
 */
exports.verifyRefreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return next(new AppError('Refresh token requis', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }
  
  // Vérifier le refresh token
  const decoded = authService.verifyRefreshToken(refreshToken);
  
  if (decoded.type !== 'affiliate') {
    return next(new AppError('Type de token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN));
  }
  
  // Vérifier si l'affilié existe et possède ce refresh token
  const affiliate = await Affiliate.findById(decoded.id).select('+refreshTokens');
  
  if (!affiliate || !affiliate.refreshTokens.includes(refreshToken)) {
    return next(new AppError('Refresh token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN));
  }
  
  if (!affiliate.isActive) {
    return next(new AppError('Compte affilié désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  req.affiliate = affiliate;
  req.refreshToken = refreshToken;
  next();
});