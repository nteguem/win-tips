const express = require('express');
const {
  createFormation,
  getFormations,
  getFormationById,
  updateFormation,
  deleteFormation,
} = require('../../controllers/admin/formationController');

const router = express.Router();


// Routes CRUD pour les formations
router.route('/')
  .post(createFormation)      // POST /api/admin/formations
  .get(getFormations);        // GET /api/admin/formations?lang=fr&isActive=true

router.route('/:id')
  .get(getFormationById)      // GET /api/admin/formations/:id?lang=fr
  .put(updateFormation)       // PUT /api/admin/formations/:id
  .delete(deleteFormation);   // DELETE /api/admin/formations/:id


module.exports = router;