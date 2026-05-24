/**
 * @fileoverview Routes du catalogue public — lecture seule, sans auth.
 *
 * Monté sur `/api/public/catalog`. Voir `publicCatalogController.js` pour
 * le contexte et les avertissements V1/V2.
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/common/publicCatalogController');

router.get('/categories', ctrl.listAllCategories);

module.exports = router;
