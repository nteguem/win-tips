const jwt = require('jsonwebtoken');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const Affiliate = require('../../models/affiliate/Affiliate');

class AuthService {
  /**
   * Générer les tokens JWT pour un utilisateur
   */
  generateTokens(userId, type) {
    const durations = {
      admin: process.env.ADMIN_TOKEN_DURATION || '180m',
      affiliate: process.env.AFFILIATE_TOKEN_DURATION || '1d',
      user: process.env.USER_TOKEN_DURATION || '120d'
    };
    
    const secrets = {
      admin: process.env.JWT_ADMIN_SECRET,
      affiliate: process.env.JWT_AFFILIATE_SECRET,
      user: process.env.JWT_USER_SECRET
    };
    
    const accessToken = jwt.sign(
      { id: userId, type },
      secrets[type],
      { expiresIn: durations[type] }
    );
    
    const refreshToken = jwt.sign(
      { id: userId, type },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '180d' }
    );
    
    return { accessToken, refreshToken };
  }

  /**
   * Vérifier un token JWT
   */
  verifyToken(token, type) {
    const secrets = {
      admin: process.env.JWT_ADMIN_SECRET,
      affiliate: process.env.JWT_AFFILIATE_SECRET,
      user: process.env.JWT_USER_SECRET
    };
    
    try {
      return jwt.verify(token, secrets[type]);
    } catch (error) {
      throw new AppError('Token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN);
    }
  }

  /**
   * Vérifier un refresh token
   */
  verifyRefreshToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch (error) {
      throw new AppError('Refresh token invalide', 401, ErrorCodes.AUTH_INVALID_TOKEN);
    }
  }

  /**
   * Valider un code d'affiliation
   */
  async validateAffiliateCode(code) {
    if (!code) return null;
    
    const affiliate = await Affiliate.findOne({ 
      affiliateCode: code.toUpperCase(),
      isActive: true 
    });
    
    if (!affiliate) {
      throw new AppError('Code d\'affiliation invalide', 400, ErrorCodes.VALIDATION_ERROR);
    }
    
    return affiliate;
  }

  /**
   * Formater la réponse d'authentification
   */
  formatAuthResponse(user, tokens, message = 'Connexion réussie') {
    return {
      success: true,
      message,
      data: {
        user: {
          id: user._id,
          phone: user.phone,
          email: user.email,
          pseudo: user?.pseudo,
          firstName: user.firstName,
          lastName: user.lastName,
          ...(user.affiliateCode && { affiliateCode: user.affiliateCode }),
          ...(user.commissionRate && { commissionRate: user.commissionRate })
        },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken
      }
    };
  }
}

module.exports = new AuthService();