const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
    select: false
  },
  firstName: String,
  lastName: String,
  phone: String,
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: Date,
  refreshTokens: [String],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Hash password avant sauvegarde
adminSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Comparer mot de passe
adminSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Supprimer champs sensibles du JSON
adminSchema.methods.toJSON = function() {
  const admin = this.toObject();
  delete admin.password;
  delete admin.refreshTokens;
  delete admin.__v;
  return admin;
};

module.exports = mongoose.model('Admin', adminSchema);