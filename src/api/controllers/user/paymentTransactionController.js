const { AppError, ErrorCodes } = require('../../../utils/AppError');
const safety = require('../../services/user/paymentTransactionSafety');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');

function ownerId(record) { return String(record.user?._id || record.user); }

async function owned(Model, idField, transactionId, userId) {
  if (typeof transactionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(transactionId)) {
    throw new AppError('Référence de paiement invalide', 400, ErrorCodes.VALIDATION_ERROR);
  }
  // Check ownership before any provider request or update, avoiding a PSP
  // request triggered by a user who does not own the referenced transaction.
  const transaction = await Model.findOne({ [idField]: transactionId, user: userId });
  if (!transaction || ownerId(transaction) !== String(userId)) throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
  return transaction;
}

async function activate(Model, transaction) {
  let subscription = null;
  try { subscription = await paymentMiddleware.processTransactionUpdate(transaction); } catch (_) {
    // A confirmed payment remains recoverable. The client must not display
    // success until the durable subscription is attached to this transaction.
  }
  return { transaction: await Model.findById(transaction._id).populate(['package', 'user']), subscription };
}

async function verify(Model, idField, service, transactionId, userId) {
  const current = await owned(Model, idField, transactionId, userId);
  let transaction;
  try { transaction = await service.checkTransactionStatus(transactionId); } catch (_) {
    await Model.updateOne({ _id: current._id }, { $set: {
      verificationPending: true, lastVerificationError: 'PROVIDER_VERIFICATION_RETRY_REQUIRED', webhookPending: true
    } });
    transaction = await Model.findById(current._id).populate(['package', 'user']);
  }
  return activate(Model, transaction);
}

function responseData(transaction, subscription = null) {
  return {
    transaction: safety.publicTransaction(transaction), paymentUrl: transaction.paymentUrl || null,
    subscription: subscription ? { id: subscription._id, startDate: subscription.startDate,
      endDate: subscription.endDate, status: subscription.status } : null
  };
}

async function pending(Model, req, res) {
  const clientReference = safety.validateClientReference(req.query.clientReference);
  const packageId = req.query.packageId;
  if (packageId && (typeof packageId !== 'string' || !/^[a-f0-9]{24}$/i.test(packageId))) throw new AppError('Package invalide', 400, ErrorCodes.VALIDATION_ERROR);
  if (!clientReference && !packageId) throw new AppError('packageId ou clientReference est requis', 400, ErrorCodes.VALIDATION_ERROR);
  const filter = { user: req.user._id };
  if (clientReference) filter.clientReference = clientReference;
  else filter.$or = [
    { status: { $in: ['PENDING', 'INITIATED', 'WAITING_FOR_CUSTOMER'] } },
    { status: { $in: ['SUCCESS', 'ACCEPTED'] }, processed: { $ne: true } },
    { status: { $in: ['SUCCESS', 'ACCEPTED'] }, subscriptionId: null }
  ];
  if (packageId) filter.package = packageId;
  const transaction = await Model.findOne(filter).sort({ createdAt: -1 });
  if (!transaction) return res.status(200).json({ success: true, data: { transaction: null } });
  const activated = await activate(Model, transaction);
  return res.status(200).json({ success: true, data: responseData(activated.transaction, activated.subscription) });
}

function initiationResponse(res, result) {
  const refused = ['FAILED', 'EXPIRED', 'REFUSED', 'CANCELED'].includes(result.transaction.status);
  const pending = result.pending || result.transaction.verificationPending || (!result.paymentUrl && result.transaction.status === 'PENDING');
  return res.status(refused ? 422 : pending ? 202 : 201).json({
    success: !refused,
    message: refused ? 'Le paiement a été refusé. Vous pouvez réessayer.' : pending ? 'Vérification du paiement en cours. Ne relancez pas le paiement.' : 'Paiement initié',
    data: responseData(result.transaction)
  });
}

async function queueWebhook(Model, idField, transactionId, service, notifyToken) {
  const transaction = await Model.findOne({ [idField]: transactionId });
  if (!transaction) return { statusCode: 200, success: false, message: 'Transaction non trouvée' };
  if (transaction.notifyToken && notifyToken && transaction.notifyToken !== notifyToken) {
    return { statusCode: 403, success: false, message: 'Notification invalide' };
  }
  // Durable marker is committed before acknowledging the webhook. A missing
  // provider response is recoverable by the worker, even if no retry arrives.
  await Model.updateOne({ _id: transaction._id }, { $set: { webhookPending: true, webhookReceivedAt: new Date() } });
  try {
    const updated = await service.checkTransactionStatus(transactionId);
    const activated = await activate(Model, updated);
    const successNeedsActivation = ['SUCCESS', 'ACCEPTED'].includes(activated.transaction.status) && !activated.transaction.processed;
    await Model.updateOne({ _id: transaction._id }, { $set: { webhookPending: !!successNeedsActivation } });
    return { statusCode: 200, success: true, status: activated.transaction.status, message: 'Notification prise en compte' };
  } catch (_) {
    // Reconciliation is already queued; a temporary provider failure is not a
    // failed payment and does not mark the transaction processed.
    return { statusCode: 202, success: true, message: 'Vérification planifiée' };
  }
}

module.exports = { owned, activate, verify, responseData, pending, initiationResponse, queueWebhook };
