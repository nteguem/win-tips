const express = require('express');
const userAuth = require('../../middlewares/user/userAuth');
const controller = require('../../controllers/common/editorialController');
const router = express.Router();
router.use(userAuth.optional);
router.get('/feed', controller.feed);
router.get('/items/:id/analysis', controller.analysis);
module.exports = router;
