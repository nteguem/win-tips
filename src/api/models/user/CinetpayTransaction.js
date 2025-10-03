// models/user/CinetpayTransaction.js
const mongoose = require('mongoose');

const cinetpayTransactionSchema = new mongoose.Schema({
  transactionId: {
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
  paymentToken: {
    type: String
  },
  paymentUrl: {
    type: String
  },
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
    enum: ['PENDING', 'ACCEPTED', 'REFUSED', 'WAITING_FOR_CUSTOMER', 'CANCELED'],
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
  description: {
    type: String
  },
  paymentMethod: {
    type: String // OMCM, MOMO, CARD, etc.
  },
  operatorTransactionId: {
    type: String // operator_id retourné par CinetPay
  },
  paymentDate: {
    type: Date
  },
  fundAvailabilityDate: {
    type: Date
  },
  
  // URLs
  notifyUrl: {
    type: String
  },
  returnUrl: {
    type: String
  },
  
  // Réponse API
  apiResponseId: {
    type: String
  },
  
  // Champs webhook CinetPay
  cpmTransDate: {
    type: Date
  },
  cpmErrorMessage: {
    type: String // SUCCES, PAYMENT_FAILED, TRANSACTION_CANCEL
  },
  cpmPhonePrefix: {
    type: String
  },
  cpmLanguage: {
    type: String
  },
  cpmVersion: {
    type: String
  },
  cpmPaymentConfig: {
    type: String
  },
  cpmPageAction: {
    type: String
  },
  cpmCustom: {
    type: String
  },
  cpmDesignation: {
    type: String
  },
  webhookSignature: {
    type: String
  },
  
  // Erreurs
  errorCode: {
    type: String
  },
  errorMessage: {
    type: String
  },
  
  processed: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index pour performance
cinetpayTransactionSchema.index({ transactionId: 1 });
cinetpayTransactionSchema.index({ user: 1, status: 1 });
cinetpayTransactionSchema.index({ paymentToken: 1 });
cinetpayTransactionSchema.index({ processed: 1 });

// Méthodes utiles
cinetpayTransactionSchema.methods.isSuccessful = function() {
  return this.status === 'ACCEPTED';
};

cinetpayTransactionSchema.methods.isPending = function() {
  return this.status === 'PENDING';
};

module.exports = mongoose.model('CinetpayTransaction', cinetpayTransactionSchema);