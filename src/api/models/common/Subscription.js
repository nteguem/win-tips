const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
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
  // Immutable purchased rights; omitted legacy records retain historical lookup.
  categorySnapshot: { type: [mongoose.Schema.Types.ObjectId], ref: 'Category', default: undefined, immutable: true },
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: true
  },
  // Prix payé en argent. Quand `paymentProvider='ADS'`, amount = 0 et
  // currency = 'XAF' (placeholder), car aucune transaction monétaire n'a
  // eu lieu — l'utilisateur a "payé" en regardant des pubs.
  pricing: {
    source: { type: String, enum: ['configured_catalogue_reference'], default: undefined },
    amount: {
      type: Number,
      required: true,
      default: 0
    },
    currency: {
      type: String,
      required: true,
      enum: ['XAF','XOF','GMD','CDF','GNF','USD','EUR','NGN','GHS','KES','ZAR','EGP','TZS','UGX','ZMW','MWK','RWF','SLE','MZN','LSL'],
      default: 'XAF'
    }
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled'],
    default: 'active'
  },
  paymentReference: String,
  paymentProvider: {
    type: String,
    // 'ADS' : abonnement débloqué en regardant N pubs récompensées
    // (paymentMode='ads' côté Package). Aucune transaction monétaire.
    enum: ['MOBILE_MONEY', 'GOOGLE_PLAY', 'ADS'],
    default: 'MOBILE_MONEY',
    required: true
  },

googlePlayTransaction: {
  type: mongoose.Schema.ObjectId,
  ref: 'GooglePlayTransaction'
},

autoRenewing: {
  type: Boolean,
  default: false
},

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Capture new managed package rights for every purchase channel, never retrofit
// an existing subscriber from a package edited after their purchase.
subscriptionSchema.pre('validate', async function() {
  if (!this.isNew || this.categorySnapshot !== undefined) return;
  const pkg = await mongoose.model('Package').findById(this.package).session(this.$session());
  const { snapshotForPackage } = require('../../services/common/subscriptionEntitlements');
  const snapshot = snapshotForPackage(pkg);
  if (snapshot.categorySnapshot) this.categorySnapshot = snapshot.categorySnapshot;
});

// Index pour performance
subscriptionSchema.index({ user: 1, status: 1 });
subscriptionSchema.index({ endDate: 1 });
subscriptionSchema.index({ status: 1 });

// Vérifier si l'abonnement est actif
subscriptionSchema.methods.isActive = function() {
  return this.status === 'active' && this.endDate > new Date();
};

// Expirer l'abonnement
subscriptionSchema.methods.expire = function() {
  this.status = 'expired';
  return this.save();
};

// Annuler l'abonnement
subscriptionSchema.methods.cancel = function() {
  this.status = 'cancelled';
  return this.save();
};

// Middleware pour mettre à jour automatiquement le status
subscriptionSchema.pre('find', function() {
  this.where({ endDate: { $gt: new Date() } });
});

subscriptionSchema.pre('findOne', function() {
  if (this.getQuery().status === 'active') {
    this.where({ endDate: { $gt: new Date() } });
  }
});

// Supprimer champs sensibles du JSON
subscriptionSchema.methods.toJSON = function() {
  const subscription = this.toObject();
  delete subscription.__v;
  return subscription;
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
