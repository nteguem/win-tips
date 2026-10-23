const express = require('express');
// Bug historique : ce fichier importait `admin/packageController` et exposait
// `getAllPackages` (méthode admin sans filter `paymentMode`). Du coup le filter
// ajouté côté `user/packageController.getAvailablePackages` n'était JAMAIS
// appelé — Express matchait toujours cette route en premier sur /user/packages.
const packageController = require('../../controllers/user/packageController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

router.use(userAuth.protect);

router.route('/')
  .get(packageController.getAvailablePackages);

module.exports = router;