// src/api/routes/common/internalSyncRoutes.js
//
// ⚠️ ROUTES PUBLIQUES (V1) — pas d'auth.
// Voir internalSyncController.js pour le contexte et le plan d'auth V2.

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/common/internalSyncController');

// Bigwin pousse les tickets publies. Wintips resout la cible via Category.externalSources.
router.post('/tickets', ctrl.createTicket);
router.post('/tickets/:id/predictions', ctrl.bulkPredictions);
router.put('/tickets/:id/publish', ctrl.publishTicket);

module.exports = router;
