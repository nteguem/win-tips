const crypto = require('crypto');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

function validateClientReference(value) {
  if (value == null || value === '') return undefined; // Existing mobile versions.
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError('clientReference doit être un UUID v4', 400, ErrorCodes.VALIDATION_ERROR);
  }
  return value.toLowerCase();
}

// The existing unique PSP ID index arbitrates concurrent requests, including
// requests reaching separate processes. A retry never generates a second charge.
function referenceId(provider, userId, clientReference) {
  const hex = crypto.createHash('sha256').update(`${provider}:${userId}:${clientReference}`).digest('hex');
  if (provider === 'cinetpay') return `PF${hex.slice(0, 26).toUpperCase()}`;
  const chars = hex.slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function snapshot(packageDoc, amount, currency) {
  return {
    packageId: String(packageDoc._id),
    packageName: packageDoc.name?.toObject ? packageDoc.name.toObject() : packageDoc.name,
    packageDescription: packageDoc.description?.toObject ? packageDoc.description.toObject() : packageDoc.description,
    packageType: packageDoc.type,
    packageDuration: packageDoc.duration,
    durationUnit: 'days',
    packageCouponTypes: (packageDoc.categories || []).map(value => String(value?._id || value)),
    formationId: packageDoc.formationId ? String(packageDoc.formationId?._id || packageDoc.formationId) : null,
    amount: Number(amount), currency
  };
}

function assertSamePurchase(transaction, packageId, fields = {}) {
  if (String(transaction.package?._id || transaction.package) !== String(packageId) ||
      Object.entries(fields).some(([key, value]) => value != null && String(transaction[key]) !== String(value))) {
    throw new AppError('Cette tentative appartient à un autre paiement. Créez une nouvelle tentative.', 409, ErrorCodes.DUPLICATE_OPERATION);
  }
}

// Update only provider fields, never write an old document over an activation
// that another callback has just committed. A verified success cannot regress.
async function updateStatus(Model, transaction, status, patch, successfulStatus) {
  const filter = { _id: transaction._id };
  const terminal = successfulStatus === 'SUCCESS' ? ['SUCCESS', 'FAILED', 'EXPIRED'] : ['ACCEPTED', 'REFUSED', 'CANCELED'];
  if (status !== successfulStatus) {
    filter.status = { $nin: terminal };
  }
  const changes = { ...patch };
  if (status) changes.status = status;
  const updated = await Model.findOneAndUpdate(filter, { $set: changes }, { new: true }).populate(['package', 'user']);
  if (updated) return updated;
  // Preserve the final status but keep the audit/recovery observation current.
  delete changes.status;
  if (patch.reconciliationMismatch === true) {
    // A later malformed observation cannot invalidate a receipt that was
    // already independently verified and committed as settled.
    delete changes.reconciliationMismatch;
    delete changes.providerData;
  }
  return Model.findOneAndUpdate({ _id: transaction._id }, { $set: changes }, { new: true }).populate(['package', 'user']);
}

function publicTransaction(transaction) {
  return {
    transactionId: transaction.depositId || transaction.transactionId,
    depositId: transaction.depositId,
    clientReference: transaction.clientReference,
    clientReferenceId: transaction.clientReferenceId,
    packageId: String(transaction.package?._id || transaction.package),
    package: transaction.package,
    amount: transaction.amount, currency: transaction.currency, status: transaction.status,
    processed: transaction.processed === true,
    subscriptionId: transaction.subscriptionId ? String(transaction.subscriptionId?._id || transaction.subscriptionId) : null,
    provider: transaction.provider, countryCode: transaction.countryCode,
    phoneNumber: transaction.phoneNumber, environment: transaction.environment,
    failureCode: transaction.failureCode || transaction.errorCode,
    failureMessage: transaction.failureMessage || transaction.errorMessage,
    cinetpayTransactionId: transaction.cinetpayTransactionId,
    customerName: transaction.customerName,
    paymentMethod: transaction.paymentMethod,
    initiationPhase: transaction.initiationPhase,
    retryable: transaction.retryable === true,
    requiresInput: transaction.requiresInput === true,
    canStartNewCheckout: transaction.canStartNewCheckout === true,
    createdAt: transaction.createdAt,
    verificationPending: transaction.verificationPending === true,
    paymentUrl: transaction.paymentUrl || null
  };
}

async function prepareRetry(Model, transaction, patch) {
  const filter = { _id: transaction._id, initiationPhase: transaction.initiationPhase,
    initiationClaimedAt: transaction.initiationClaimedAt || { $exists: false },
    status: { $nin: ['SUCCESS', 'ACCEPTED', 'FAILED', 'EXPIRED', 'REFUSED', 'CANCELED'] } };
  const updated = await Model.findOneAndUpdate(filter, { $set: patch }, { new: true }).populate(['package', 'user']);
  return updated || Model.findById(transaction._id).populate(['package', 'user']);
}

module.exports = { validateClientReference, referenceId, snapshot, assertSamePurchase, updateStatus, publicTransaction, prepareRetry };
