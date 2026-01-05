const express = require('express');
const formationController = require('../../controllers/user/formationController');
const userAuth = require('../../middlewares/user/userAuth');
const checkSubscription = require('../../middlewares/user/checkSubscription');

const router = express.Router();

/**
 * Middleware conditionnel optionnel pour l'authentification
 * N'applique l'auth que si le token est présent, sinon continue sans user
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Token présent : appliquer l'authentification
    userAuth.protect(req, res, next);
  } else {
    // Pas de token : continuer sans utilisateur
    req.user = null;
    next();
  }
};

/**
 * ✅ Middleware conditionnel pour l'accès au contenu d'une formation
 * - Si formation FREE (requiredPackages vide) : accès public
 * - Si formation VIP (requiredPackages non vide) : authentification + vérification
 */
const conditionalFormationMiddleware = (req, res, next) => {
  // Appliquer l'authentification d'abord
  userAuth.protect(req, res, (authErr) => {
    if (authErr) {
      // Si erreur d'auth, l'utilisateur n'est pas connecté
      req.user = null;
    }
    
    // Vérifier l'accès aux formations avec le nouveau middleware
    checkSubscription.checkFormationAccess(req, res, next);
  });
};

/**
 * Routes pour les formations côté user
 * 
 * Logique d'accès :
 * - Formation FREE = requiredPackages vide ou n'existe pas → Accès public
 * - Formation VIP = requiredPackages contient au moins 1 package → Auth + vérification
 * 
 * Exemples d'utilisation :
 * - GET /formations                    // Toutes les formations (utilisateur non connecté)
 * - GET /formations?lang=en&limit=20   // Formations en anglais avec limite
 * - GET /formations (avec token)       // Formations avec accès selon abonnement
 * - GET /formations/:id/content        // Contenu d'une formation (avec vérification d'accès)
 */

// Récupérer toutes les formations avec authentification optionnelle
router.get('/', optionalAuth, formationController.getFormations);

// Récupérer une formation par ID avec authentification optionnelle
router.get('/:id', optionalAuth, formationController.getFormationById);

// ✅ Récupérer le contenu d'une formation avec middleware conditionnel
router.get('/:id/content', conditionalFormationMiddleware, formationController.getFormationContent);

module.exports = router;