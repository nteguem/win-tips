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
  purchaseTime: Date,
  
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
  lastNotificationTime: Date,

  // ===== NOUVEAUX CHAMPS POUR PRODUITS PONCTUELS =====
  // Type d'achat : SUBSCRIPTION (défaut pour rétrocompatibilité) ou ONE_TIME_PRODUCT
  purchaseType: {
    type: String,
    enum: ['SUBSCRIPTION', 'ONE_TIME_PRODUCT'],
    default: 'SUBSCRIPTION'  // ⚠️ Important : rétrocompatibilité avec transactions existantes
  },

  // État de consommation (pour produits ponctuels consommables)
  consumptionState: {
    type: String,
    enum: ['YET_TO_BE_CONSUMED', 'CONSUMED'],
    default: 'YET_TO_BE_CONSUMED'
  },

  // Quantité achetée (Google Play supporte les achats multiples)
  quantity: {
    type: Number,
    default: 1,
    min: 1,
    validate: {
      validator: function(value) {
        return Number.isInteger(value) && value >= 1;
      },
      message: 'La quantité doit être un entier positif >= 1'
    }
  },

  // Quantité remboursable (pour gérer les remboursements partiels)
  refundableQuantity: {
    type: Number,
    default: function() {
      return this.quantity || 1;
    },
    min: 0
  }
  // ===================================================
}, {
  timestamps: true
});

// Index
googlePlayTransactionSchema.index({ user: 1, status: 1 });
googlePlayTransactionSchema.index({ purchaseToken: 1 });
googlePlayTransactionSchema.index({ user: 1, purchaseType: 1 });  // Nouvel index pour filtrer par type

// ===== NOUVELLES MÉTHODES =====
// Vérifier si c'est un produit ponctuel
googlePlayTransactionSchema.methods.isOneTimeProduct = function() {
  return this.purchaseType === 'ONE_TIME_PRODUCT';
};

// Vérifier si c'est un abonnement (avec rétrocompatibilité)
googlePlayTransactionSchema.methods.isSubscription = function() {
  return this.purchaseType === 'SUBSCRIPTION' || !this.purchaseType;
};

// Vérifier si le produit a été consommé
googlePlayTransactionSchema.methods.isConsumed = function() {
  return this.consumptionState === 'CONSUMED';
};

// Marquer comme consommé
googlePlayTransactionSchema.methods.consume = async function() {
  if (this.purchaseType !== 'ONE_TIME_PRODUCT') {
    throw new Error('Seuls les produits ponctuels peuvent être consommés');
  }
  
  this.consumptionState = 'CONSUMED';
  return await this.save();
};
// ==============================

// Méthode existante - Vérifier si actif
googlePlayTransactionSchema.methods.isActive = function() {
  return this.status === 'ACTIVE' && this.expiryTime > new Date();
};

module.exports = mongoose.model('GooglePlayTransaction', googlePlayTransactionSchema);