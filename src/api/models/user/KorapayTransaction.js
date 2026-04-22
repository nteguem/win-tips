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
 * Enregistre les infos d'un webhook KoraPay et met à jour le statut.
 */
korapayTransactionSchema.methods.recordWebhook = function(webhookData) {
  this.webhookReceived = true;
  this.webhookData = {
    event: webhookData.event,
    receivedAt: new Date()
  };

  if (webhookData.event === 'charge.success') {
    this.status = 'SUCCESS';
    this.paymentDate = new Date();
  } else if (webhookData.event === 'charge.failed') {
    this.status = 'FAILED';
  }

  if (webhookData.data) {
    const data = webhookData.data;
    if (data.reference) this.korapayReference = data.reference;
    if (data.payment_method) this.paymentMethod = data.payment_method;
    if (data.fee !== undefined) this.fee = data.fee;
    if (data.amount_charged !== undefined) this.amountCharged = data.amount_charged;
    if (data.status) this.responseMessage = data.status;
  }

  return this.save();
};

/**
 * Retrouve une transaction par n'importe laquelle de ses références.
 */
korapayTransactionSchema.statics.findByReference = function(reference) {
  return this.findOne({
    $or: [
      { transactionId: reference },
      { reference: reference },
      { korapayReference: reference }
    ]
  }).populate(['package', 'user']);
};

module.exports = mongoose.model('KorapayTransaction', korapayTransactionSchema);
