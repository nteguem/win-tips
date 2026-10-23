const express = require('express');
const workerAuth = require('../../middlewares/common/editorialWorkerAuth');
const controller = require('../../controllers/common/editorialController');
const router = express.Router();
router.use(workerAuth);
router.get('/config', controller.workerConfig);
router.post('/import', controller.importBatch);
router.post('/notifications/drain', controller.drainNotifications);
module.exports = router;
