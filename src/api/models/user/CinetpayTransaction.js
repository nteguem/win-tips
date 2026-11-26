// models/user/CinetpayTransaction.js
//
// Transaction CinetPay — nouvelle API (api.cinetpay.co/v1).
// `transactionId` = merchant_transaction_id envoyé à CinetPay (notre id,
// max 30 chars). `cinetpayTransactionId` = id retourné par CinetPay.

const mongoose = require('mongoose');

const cinetpayTransactionSchema = new mongoose.Schema({
  // Immutable purchase and recoverable verification state. No TTL: a settled
  // payment remains traceable even after a network error or app closure.
  clientReference: { type: String, trim: true },
  canStartNewCheckout: { type: Boolean, default: false },
  replacesTransactionId: String,
  initiationPhase: { type: String, enum: ['PREPARED', 'SUBMITTING', 'SUBMITTED', 'UNCERTAIN', 'REQUIRES_INPUT', 'REJECTED'] },
  initiationClaimedAt: Date,
  initiationAttempts: { type: Number, default: 0 },
  retryable: { type: Boolean, default: false },
  requiresInput: { type: Boolean, default: false },
  requiresPreAuth: { type: Boolean, default: false },
  paymentSnapshot: mongoose.Schema.Types.Mixed,
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  activationError: String,
  activatedAt: Date,
  activationNotificationClaimedAt: Date,
  failureNotificationClaimedAt: Date,
  reconciliationMismatch: { type: Boolean, default: false },
  verificationPending: { type: Boolean, default: false },
  lastVerificationError: String,
  webhookPending: { type: Boolean, default: false },
  webhookReceivedAt: Date,
  nextCheckAt: Date,
  apiVersion: { type: String, enum: ['legacy-v2', 'v1'] },
  lastCheckedAt: Date,
  checkAttempts: { type: Number, default: 0 },

  transactionId: {
    type: String,
    required: true,
    unique: true
  },

  cinetpayTransactionId: String,

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  package: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    required: true
  },

  paymentToken: String,
  notifyToken: String,
  paymentUrl: String,

  amount: {
    type: Number,
    required: true
  },

  currency: {
    type: String,
    default: 'XOF'
  },

  status: {
    type: String,
    enum: ['PENDING', 'INITIATED', 'ACCEPTED', 'REFUSED', 'WAITING_FOR_CUSTOMER', 'CANCELED'],
    default: 'PENDING'
  },

  // Optionnel : avec le checkout hosté, le n° est saisi sur la page
  // CinetPay → on ne le demande plus au mobile.
  phoneNumber: String,

  customerEmail: String,
  customerName: {
    type: String,
    required: true
  },

  description: String,
  paymentMethod: String,
  paymentDate: Date,

  notifyUrl: String,
  returnUrl: String,

  // Réponse `details` de l'API CinetPay (init + status check)
  detailsCode: Number,
  detailsStatus: String,
  detailsMessage: String,
  mustBeRedirected: Boolean,

  errorCode: String,
  errorMessage: String,

  processed: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

cinetpayTransactionSchema.index({ user: 1, clientReference: 1 });
cinetpayTransactionSchema.index({ status: 1, nextCheckAt: 1, createdAt: -1 });
// transactionId : index déjà créé par `unique: true` ci-dessus.
cinetpayTransactionSchema.index({ cinetpayTransactionId: 1 });
cinetpayTransactionSchema.index({ user: 1, status: 1 });
cinetpayTransactionSchema.index({ processed: 1 });
cinetpayTransactionSchema.index({ notifyToken: 1 });

cinetpayTransactionSchema.methods.isSuccessful = function () {
  return this.status === 'ACCEPTED';
};

cinetpayTransactionSchema.methods.isPending = function () {
  return this.status === 'PENDING' || this.status === 'INITIATED' || this.status === 'WAITING_FOR_CUSTOMER';
};

module.exports = mongoose.model('CinetpayTransaction', cinetpayTransactionSchema);
