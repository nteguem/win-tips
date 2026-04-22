const mongoose = require('mongoose');

const smobilpayTransactionSchema = new mongoose.Schema({
  paymentId: {
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
  serviceId: {
    type: String,
    required: true
  },
  operatorName: {
    type: String,
    required: true
  },
  payItemId: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'XAF',
    enum: ['XAF', 'XOF', 'GMD', 'CDF', 'GNF']
  },
  status: {
    type: String,
    enum: ['PENDING', 'SUCCESS', 'ERROR', 'EXPIRED'],
    default: 'PENDING'
  },
  phoneNumber: {
    type: String,
    required: true
  },
  customerName: {
    type: String,
    required: true
  },
  email: {
    type: String
  },
  // Champs spécifiques Smobilpay
  ptn: String,
  quoteId: String,
  receiptNumber: String,
  veriCode: String,
  timestamp: Date,
  clearingDate: Date,
  priceLocalCur: String,
  pin: String,
  tag: String,
  errorCode: String,
  processed: {
    type: Boolean,
    default: false
  },
  // Date du dernier check côté Maviance (utilisé pour le backoff du cron)
  lastCheckedAt: Date,
  // Compteur de tentatives de vérification (info/debug)
  checkAttempts: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index pour performance
smobilpayTransactionSchema.index({ user: 1, status: 1 });
smobilpayTransactionSchema.index({ paymentId: 1 });
smobilpayTransactionSchema.index({ ptn: 1 });
smobilpayTransactionSchema.index({ processed: 1 });
// Index pour le cron de vérification (scan rapide des PENDING récentes)
smobilpayTransactionSchema.index({ status: 1, createdAt: -1 });

// Méthodes utiles
smobilpayTransactionSchema.methods.isSuccessful = function() {
  return this.status === 'SUCCESS';
};

smobilpayTransactionSchema.methods.isPending = function() {
  return this.status === 'PENDING';
};

module.exports = mongoose.model('SmobilpayTransaction', smobilpayTransactionSchema);