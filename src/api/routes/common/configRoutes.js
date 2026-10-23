/**
 * @fileoverview Routes de configuration par pays
 * Gère les routes publiques et admin
 */
const express = require('express');
const configController = require('../../controllers/common/configController');
const adminAuth = require('../../middlewares/admin/adminAuth');

const router = express.Router();

/**
 * Routes publiques (sans authentification)
 */
// Obtenir config par IP (onboarding)
router.post('/', configController.getConfigByIp);

// Liste publique des pays actifs (selecteur de pays mobile).
// DOIT etre declaree AVANT /:countryCode sinon "countries" est capture
// comme un code pays.
router.get('/countries', configController.getActiveCountries);

/**
 * Routes protégées admin (authentification requise).
 * IMPORTANT : déclarées AVANT GET /:countryCode, sinon "/config/admin" est
 * capturé par la route générique comme un code pays (countryCode="admin").
 */
router.use('/admin', adminAuth.protect);

// Lister toutes les configurations
router.get('/admin', configController.getAllConfigs);

// Créer une nouvelle configuration
router.post('/admin', configController.createConfig);

// Mettre à jour une configuration
router.put('/admin/:countryCode', configController.updateConfig);

// Supprimer une configuration
router.delete('/admin/:countryCode', configController.deleteConfig);

// Activer/désactiver un pays
router.patch('/admin/:countryCode/toggle', configController.toggleCountry);

// Vider les caches
router.post('/admin/cache/clear', configController.clearCache);

// Obtenir config par code pays — route GÉNÉRIQUE : DOIT rester APRÈS
// /countries et /admin, sinon elle les capture comme des codes pays.
router.get('/:countryCode', configController.getConfigByCountryCode);

module.exports = router;