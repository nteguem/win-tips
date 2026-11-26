const { createRecovery } = require('./paymentVerificationRecovery');

module.exports = createRecovery({
  Model: require('../../models/user/PawapayTransaction'),
  service: require('./PawapayService'),
  referenceField: 'depositId',
  successStatus: 'SUCCESS',
  label: 'Pawapay',
  paymentMiddleware: require('../../middlewares/payment/paymentMiddleware')
});
