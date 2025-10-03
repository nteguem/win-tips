// models/user/AfribaPayTransaction.js
const mongoose = require('mongoose');

const afribaPayTransactionSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true
  },
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
  operator: {
    type: String,
    required: true // mtn, orange, moov, etc.
  },
  country: {
    type: String,
    required: true // CM, CI, SN, etc.
  },
  phoneNumber: {
    type: String,
    required: true
  },
  otpCode: {
    type: String // Optionnel selon l'opérateur
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true // XAF, XOF, GMD, CDF, GNF
  },
  status: {
    type: String,
    // enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'],
    default: 'PENDING'
  },
  merchantKey: {
    type: String
  },
  referenceId: {
    type: String
  },
  
  // URLs
  notifyUrl: String,
  returnUrl: String,
  cancelUrl: String,
  
  // Réponse API AfribaPay
  providerId: String,
  providerLink: String,
  taxes: Number,
  fees: Number,
  feesTaxesTtc: Number,
  amountTotal: Number,
  dateCreated: Date,
  apiRequestId: String,
  apiRequestTime: String,
  apiRequestIp: String,
  
  // Statut et opérateur
  operatorId: String,
  statusDate: Date,
  
  // Webhook
  webhookReceived: {
    type: Boolean,
    default: false
  },
  webhookData: mongoose.Schema.Types.Mixed,
  webhookSignature: String,
  webhookVerified: {
    type: Boolean,
    default: false
  },
  
  // Client info
  lang: {
    type: String,
    default: 'fr'
  },
  clientIp: String,
  userAgent: String,
  
  // Processing
  processed: {
    type: Boolean,
    default: false
  },
  notificationSent: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index pour performance
afribaPayTransactionSchema.index({ transactionId: 1 });
afribaPayTransactionSchema.index({ orderId: 1 });
afribaPayTransactionSchema.index({ user: 1, status: 1 });
afribaPayTransactionSchema.index({ processed: 1 });

// Méthodes utiles
afribaPayTransactionSchema.methods.isSuccessful = function() {
  return this.status === 'SUCCESS';
};

afribaPayTransactionSchema.methods.isPending = function() {
  return this.status === 'PENDING';
};

module.exports = mongoose.model('AfribaPayTransaction', afribaPayTransactionSchema);