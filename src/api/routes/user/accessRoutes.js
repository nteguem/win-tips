// src/api/routes/user/accessRoutes.js
//
// Déblocage de catégories free de coupons par visionnage de pubs récompensées.
// Monté sous /user/access.

const express = require('express');
const accessController = require('../../controllers/user/accessController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

// Toutes ces routes exigent un utilisateur authentifié.
router.use(userAuth.protect);

// POST /user/access/category/:categoryId/unlock  { durationMinutes: number|null }
router.post('/category/:categoryId/unlock', accessController.unlockCategory);

// GET /user/access/category/:categoryId  → état courant (polling après pub)
router.get('/category/:categoryId', accessController.getCategoryAccessState);

module.exports = router;
