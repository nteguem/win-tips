const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  phoneNumber: {
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
  city: String,
  email: String,
  pseudo: String,
  dialCode: String,
  countryCode: String,
  referredBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'Affiliate'
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
userSchema.index({ phone: 1 });
userSchema.index({ referredBy: 1 });
userSchema.index({ isActive: 1 });

// Hash password avant sauvegarde
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Comparer mot de passe
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Supprimer champs sensibles du JSON
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  delete user.refreshTokens;
  delete user.__v;
  return user;
};

module.exports = mongoose.model('User', userSchema);