// models/user/CinetpayTransaction.js
//
// Transaction CinetPay — nouvelle API (api.cinetpay.co/v1).
// `transactionId` = merchant_transaction_id envoyé à CinetPay (notre id,
// max 30 chars). `cinetpayTransactionId` = id retourné par CinetPay.

const mongoose = require('mongoose');

const cinetpayTransactionSchema = new mongoose.Schema({
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
