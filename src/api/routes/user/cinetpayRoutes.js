// routes/user/cinetpayRoutes.js
//
// Routes CinetPay — nouvelle API (api.cinetpay.co/v1).
// Montées à /payments/cinetpay dans routes/index.js.

const express = require('express');
const cinetpayController = require('../../controllers/user/cinetpayController');
const userAuth = require('../../middlewares/user/userAuth');

const router = express.Router();

// Routes publiques (callbacks CinetPay)
router.post('/notify', cinetpayController.notify);
router.get('/return', cinetpayController.paymentReturn);
router.post('/return', cinetpayController.paymentReturn);

// Routes protégées (auth utilisateur)
router.use(userAuth.protect);
router.post('/initiate', cinetpayController.initiatePayment);
router.get('/status/:transactionId', cinetpayController.checkStatus);

module.exports = router;
