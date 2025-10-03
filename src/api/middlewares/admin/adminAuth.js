const Admin = require('../../models/admin/Admin');
const authService = require('../../services/common/authService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Middleware de protection des routes admin
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
  const decoded = authService.verifyToken(token, 'admin');
  
  // 3. Vérifier si l'admin existe encore
  const admin = await Admin.findById(decoded.id);
  if (!admin) {
    return next(new AppError('L\'administrateur n\'existe plus', 401, ErrorCodes.AUTH_USER_NOT_FOUND));
  }
  
  // 4. Vérifier si l'admin est actif
  if (!admin.isActive) {
    return next(new AppError('Compte administrateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  // 5. Attacher l'admin à la requête
  req.admin = admin;
  next();
});

/**
 * Middleware pour vérifier les refresh tokens admin
 */
exports.verifyRefreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return next(new AppError('Refresh token requis', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }
  
  // Vérifier le refresh token
  const decoded = authService.verifyRefreshToken(refreshToken);
  
  if (decoded.type !== 'admin') {
    return next(new AppError('Type de token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN));
  }
  
  // Vérifier si l'admin existe et possède ce refresh token
  const admin = await Admin.findById(decoded.id).select('+refreshTokens');
  
  if (!admin || !admin.refreshTokens.includes(refreshToken)) {
    return next(new AppError('Refresh token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN));
  }
  
  if (!admin.isActive) {
    return next(new AppError('Compte administrateur désactivé', 401, ErrorCodes.AUTH_ACCOUNT_DISABLED));
  }
  
  req.admin = admin;
  req.refreshToken = refreshToken;
  next();
});