const express = require('express');
const formationController = require('../../controllers/user/formationController');
const userAuth = require('../../middlewares/user/userAuth');

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
 * Routes pour les formations côté user
 * Exemples d'utilisation :
 * - GET /formations                    // Toutes les formations (utilisateur non connecté)
 * - GET /formations?lang=en&limit=20   // Formations en anglais avec limite
 * - GET /formations (avec token)       // Formations avec accès selon abonnement
 */

// Récupérer toutes les formations avec authentification optionnelle
router.get('/', optionalAuth, formationController.getFormations);

// Récupérer une formation par ID avec authentification optionnelle
router.get('/:id', optionalAuth, formationController.getFormationById);

module.exports = router;