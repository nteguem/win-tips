const { createRecovery } = require('./paymentVerificationRecovery');

module.exports = createRecovery({
  Model: require('../../models/user/CinetpayTransaction'),
  service: require('./CinetpayService'),
  referenceField: 'transactionId',
  successStatus: 'ACCEPTED',
  label: 'Cinetpay',
  paymentMiddleware: require('../../middlewares/payment/paymentMiddleware')
});
