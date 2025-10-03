const adminAuth = require('../admin/adminAuth');
const affiliateAuth = require('../affiliate/affiliateAuth');
const userAuth = require('../user/userAuth');
const { AppError, ErrorCodes } = require('../../utils/AppError');

/**
 * Middleware permettant l'accès aux admins OU aux users
 */
exports.adminOrUser = async (req, res, next) => {
  // Essayer admin d'abord
  try {
    await adminAuth.protect(req, res, () => {});
    if (req.admin) {
      return next();
    }
  } catch (error) {
    // Continue pour essayer user
  }
  
  // Essayer user ensuite
  try {
    await userAuth.protect(req, res, () => {});
    if (req.user) {
      return next();
    }
  } catch (error) {
    // Continue vers l'erreur finale
  }
  
  // Si aucun ne fonctionne
  return next(new AppError('Authentification requise (admin ou user)', 401, ErrorCodes.AUTH_TOKEN_MISSING));
};

/**
 * Middleware permettant l'accès aux admins OU aux affiliés
 */
exports.adminOrAffiliate = async (req, res, next) => {
  // Essayer admin d'abord
  try {
    await adminAuth.protect(req, res, () => {});
    if (req.admin) {
      return next();
    }
  } catch (error) {
    // Continue pour essayer affiliate
  }
  
  // Essayer affiliate ensuite
  try {
    await affiliateAuth.protect(req, res, () => {});
    if (req.affiliate) {
      return next();
    }
  } catch (error) {
    // Continue vers l'erreur finale
  }
  
  // Si aucun ne fonctionne
  return next(new AppError('Authentification requise (admin ou affilié)', 401, ErrorCodes.AUTH_TOKEN_MISSING));
};

/**
 * Middleware permettant l'accès à tous les types d'utilisateurs
 */
exports.any = async (req, res, next) => {
  // Essayer admin d'abord
  try {
    await adminAuth.protect(req, res, () => {});
    if (req.admin) {
      return next();
    }
  } catch (error) {
    // Continue
  }
  
  // Essayer affiliate
  try {
    await affiliateAuth.protect(req, res, () => {});
    if (req.affiliate) {
      return next();
    }
  } catch (error) {
    // Continue
  }
  
  // Essayer user
  try {
    await userAuth.protect(req, res, () => {});
    if (req.user) {
      return next();
    }
  } catch (error) {
    // Continue vers l'erreur finale
  }
  
  // Si aucun ne fonctionne
  return next(new AppError('Authentification requise', 401, ErrorCodes.AUTH_TOKEN_MISSING));
};