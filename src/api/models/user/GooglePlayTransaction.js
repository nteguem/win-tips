const mongoose = require('mongoose');

const googlePlayTransactionSchema = new mongoose.Schema({
  // Identifiants Google
  purchaseToken: {
    type: String,
    required: true,
    unique: true
  },
  orderId: String,
  productId: String,
  
  // Relations
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  package: {
    type: mongoose.Schema.ObjectId,
    ref: 'Package',
    required: true
  },
  subscription: {
    type: mongoose.Schema.ObjectId,
    ref: 'Subscription'
  },
  
  // État
  status: {
    type: String,
    enum: ['ACTIVE', 'EXPIRED', 'CANCELED', 'ON_HOLD', 'PAUSED'],
    default: 'ACTIVE'
  },
  
  // Dates
  startTime: Date,
  expiryTime: Date,
  
  // Paiement
  priceAmountMicros: Number,
  priceCurrencyCode: String,
  
  // Flags
  autoRenewing: {
    type: Boolean,
    default: true
  },
  acknowledged: {
    type: Boolean,
    default: false
  },
  
  // Dernière notification
  lastNotificationType: Number,
  lastNotificationTime: Date
}, {
  timestamps: true
});

// Index
googlePlayTransactionSchema.index({ user: 1, status: 1 });
googlePlayTransactionSchema.index({ purchaseToken: 1 });

// Vérifier si actif
googlePlayTransactionSchema.methods.isActive = function() {
  return this.status === 'ACTIVE' && this.expiryTime > new Date();
};

module.exports = mongoose.model('GooglePlayTransaction', googlePlayTransactionSchema);