const mongoose = require('mongoose');

const commissionSchema = new mongoose.Schema({
  affiliate: {
    type: mongoose.Schema.ObjectId,
    ref: 'Affiliate',
    required: true
  },
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  subscription: {
    type: mongoose.Schema.ObjectId,
    ref: 'Subscription',
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    enum: ['XAF', 'XOF', 'GMD','CDF','GNF'],
    default: 'XAF'
  },
  commissionRate: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  commissionAmount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'cancelled'],
    default: 'pending'
  },
  paidAt: Date,
  paymentReference: String,
  month: {
    type: Number,
    required: true,
    min: 1,
    max: 12
  },
  year: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index pour performance
commissionSchema.index({ affiliate: 1, status: 1 });
commissionSchema.index({ month: 1, year: 1 });
commissionSchema.index({ status: 1 });
commissionSchema.index({ subscription: 1 }, { unique: true }); // Une seule commission par subscription

// Marquer comme payée
commissionSchema.methods.markAsPaid = function(paymentReference) {
  this.status = 'paid';
  this.paidAt = new Date();
  this.paymentReference = paymentReference;
  return this.save();
};

// Annuler la commission
commissionSchema.methods.cancel = function() {
  this.status = 'cancelled';
  return this.save();
};

// Supprimer champs sensibles du JSON
commissionSchema.methods.toJSON = function() {
  const commission = this.toObject();
  delete commission.__v;
  return commission;
};

module.exports = mongoose.model('Commission', commissionSchema);