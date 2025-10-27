const express = require('express');
const packageController = require('../../controllers/admin/packageController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

/**
 * Toutes les routes nécessitent une authentification admin
 */
router.use(userAuth.protect);

/**
 * Routes principales
 */

router.route('/')
  .get(packageController.getAllPackages) 

module.exports = router;