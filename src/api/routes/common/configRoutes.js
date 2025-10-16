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

// Obtenir config par code pays
router.get('/:countryCode', configController.getConfigByCountryCode);

/**
 * Routes protégées admin (authentification requise)
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

module.exports = router;