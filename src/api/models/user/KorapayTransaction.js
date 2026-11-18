const mongoose = require('mongoose');

const korapayTransactionSchema = new mongoose.Schema({
  // Référence unique de la transaction (générée côté backend)
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

  // Référence envoyée à KoraPay (= transactionId)
  reference: {
    type: String,
    index: true
  },

  // Référence retournée par KoraPay après initialize
  korapayReference: String,

  // URL de checkout KoraPay
  checkoutUrl: String,

  amount: {
    type: Number,
    required: true
  },

  currency: {
    type: String,
    required: true,
    enum: ['NGN', 'KES', 'GHS', 'XAF', 'XOF', 'EGP', 'TZS', 'ZAR', 'USD'],
    uppercase: true
  },

  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'],
    default: 'PENDING'
  },

  // Infos client
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  customerPhone: String,

  description: String,

  // Méthode de paiement utilisée (retournée par KoraPay)
  paymentMethod: {
    type: String,
    enum: ['card', 'bank_transfer', 'mobile_money', 'pay_with_bank', 'virtual_account']
  },

  // Détails mobile money
  mobileMoneyDetails: {
    provider: String,
    number: String,
    authModel: { type: String, enum: ['OTP', 'STK_PROMPT'] }
  },

  fee: Number,
  vat: Number,

  amountExpected: Number,
  amountCharged: Number,

  notificationUrl: String,
  redirectUrl: String,

  // Webhook
  webhookReceived: { type: Boolean, default: false },
  webhookData: {
    event: String,
    receivedAt: Date
  },

  responseMessage: String,
  errorCode: String,
  errorMessage: String,

  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // Indique si la transaction a déjà déclenché la création de souscription
  processed: { type: Boolean, default: false },

  paymentDate: Date,

  merchantBearsCost: { type: Boolean, default: false },

  // Immutable purchase terms and server-authenticated settlement evidence.
  purchaseSnapshot: { type: mongoose.Schema.Types.Mixed, immutable: true },
  verifiedPaymentAt: Date,
  verifiedAmount: Number,
  verifiedCurrency: String,

  // Suivi des vérifications par le cron (backoff)
  lastCheckedAt: Date,
  checkAttempts: { type: Number, default: 0 }
}, {
  timestamps: true
});

// Indexes
korapayTransactionSchema.index({ reference: 1 });
korapayTransactionSchema.index({ korapayReference: 1 });
korapayTransactionSchema.index({ user: 1, status: 1 });
korapayTransactionSchema.index({ processed: 1 });
korapayTransactionSchema.index({ status: 1, createdAt: -1 });

// Méthodes utiles (alignées sur le contrat de paymentMiddleware.processTransactionUpdate)
korapayTransactionSchema.methods.isSuccessful = function() {
  return this.status === 'SUCCESS';
};

korapayTransactionSchema.methods.isPending = function() {
  return this.status === 'PENDING' || this.status === 'PROCESSING';
};

korapayTransactionSchema.methods.isFailed = function() {
  return this.status === 'FAILED' || this.status === 'CANCELLED';
};

/**
 * Enregistre uniquement la réception d'un webhook KoraPay.
 */
korapayTransactionSchema.methods.recordWebhook = function(webhookData) {
  this.webhookReceived = true;
  this.webhookData = {
    event: webhookData.event,
    receivedAt: new Date()
  };

  // Receipt bookkeeping only. A signed webhook triggers a server-side charge
  // GET; it must not directly activate, downgrade or alter payment ownership.

  return this.save();
};

/**
 * Retrouve une transaction par n'importe laquelle de ses références.
 */
korapayTransactionSchema.statics.findByReference = function(reference, userId) {
  if (typeof reference !== 'string' || !reference || reference.length > 200) return Promise.resolve(null);
  return this.findOne({
    ...(userId ? { user: userId } : {}),
    $or: [
      { transactionId: reference },
      { reference: reference },
      { korapayReference: reference }
    ]
  }).populate(['package', 'user']);
};

module.exports = mongoose.model('KorapayTransaction', korapayTransactionSchema);
