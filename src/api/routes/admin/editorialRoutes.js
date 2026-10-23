const express = require('express');
const adminAuth = require('../../middlewares/admin/adminAuth');
const controller = require('../../controllers/common/editorialController');
const router = express.Router();
router.use(adminAuth.protect);
router.get('/sources', controller.catalog);
module.exports = router;
