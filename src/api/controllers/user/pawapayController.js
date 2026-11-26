const service = require('../../services/user/PawapayService');
const Transaction = require('../../models/user/PawapayTransaction');
const subscriptionService = require('../../services/user/subscriptionService');
const safety = require('../../services/user/paymentTransactionSafety');
const controller = require('./paymentTransactionController');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

exports.getProviders = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getProvidersAsync(req.query.country) });
});

exports.initiatePayment = catchAsync(async (req, res) => {
  const { packageId, phoneNumber, operator, country, provider, clientReference, preAuthorisationCode } = req.body;
  if (typeof packageId !== 'string' || !/^[a-f0-9]{24}$/i.test(packageId) || typeof phoneNumber !== 'string' || (!operator && !provider)) {
    throw new AppError('packageId, phoneNumber et opérateur sont requis', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const reference = safety.validateClientReference(clientReference);
  const retry = reference && await Transaction.findOne({ user: req.user._id, clientReference: reference });
  if (!retry) {
    const subscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
    if (subscriptions.some(sub => String(sub.package?._id || sub.package) === packageId)) throw new AppError('Vous avez déjà un accès actif pour ce package', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const result = await service.initiatePayment(req.user, packageId, phoneNumber, operator, country, provider, reference, preAuthorisationCode);
  return controller.initiationResponse(res, result);
});

exports.checkStatus = catchAsync(async (req, res) => {
  const result = await controller.verify(Transaction, 'depositId', service, req.params.depositId, req.user._id);
  res.status(200).json({ success: true, data: controller.responseData(result.transaction, result.subscription) });
});

exports.pending = catchAsync(async (req, res) => controller.pending(Transaction, req, res));

exports.webhook = catchAsync(async (req, res) => {
  const depositId = req.body?.depositId;
  if (typeof depositId !== 'string' || !/^[a-f0-9-]{36}$/i.test(depositId)) return res.status(400).json({ success: false, message: 'depositId invalide' });
  const { statusCode, ...body } = await controller.queueWebhook(Transaction, 'depositId', depositId, service);
  return res.status(statusCode).json(body);
});
