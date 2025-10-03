const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const affiliateSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
    select: false
  },
  email: String,
  firstName: String,
  lastName: String,
  country: String,
  city: String,
  district: String,
  affiliateCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  affiliateType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AffiliateType',
    default: null
  },
  totalEarnings: {
    type: Number,
    default: 0
  },
  pendingBalance: {
    type: Number,
    default: 0
  },
  paidBalance: {
    type: Number,
    default: 0
  },
  paymentInfo: {
    method: {
      type: String,
      enum: ['MOBILE_MONEY', 'BANK_TRANSFER', 'CASH']
    },
    mobileNumber: String,
    bankDetails: {
      bankName: String,
      accountNumber: String,
      accountName: String
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  refreshTokens: [String],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index
affiliateSchema.index({ phone: 1 });
affiliateSchema.index({ affiliateCode: 1 });
affiliateSchema.index({ isActive: 1 });
affiliateSchema.index({ affiliateType: 1 });

// Hash password avant sauvegarde
affiliateSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Comparer mot de passe
affiliateSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Supprimer champs sensibles du JSON
affiliateSchema.methods.toJSON = function() {
  const affiliate = this.toObject();
  delete affiliate.password;
  delete affiliate.refreshTokens;
  delete affiliate.__v;
  return affiliate;
};

module.exports = mongoose.model('Affiliate', affiliateSchema);