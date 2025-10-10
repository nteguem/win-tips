const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  // Authentification classique (téléphone + mot de passe)
  phoneNumber: {
    type: String,
    unique: true,
    sparse: true, // Permet null pour les users Google
    required: function() {
      return this.authProvider === 'local'; // Requis seulement pour auth classique
    }
  },
  password: {
    type: String,
    minlength: 6,
    select: false,
    required: function() {
      return this.authProvider === 'local'; // Requis seulement pour auth classique
    }
  },
  
  // Authentification Google
  googleId: {
    type: String,
    unique: true,
    sparse: true // Permet null pour les users classiques
  },
  authProvider: {
    type: String,
    enum: ['local', 'google'],
    required: true,
    default: 'local'
  },
  
  // Informations communes
  email: {
  type: String,
  unique: true,
  sparse: true, // Permet les valeurs null
  required: function() {
    return this.authProvider === 'google'; // Email requis seulement pour Google
  }
},
  pseudo: {
    type: String,
    required: true // Requis mais sera auto-généré pour Google
  },
  firstName: String,
  lastName: String,
  profilePicture: String, // Nouveau : photo de profil Google
  emailVerified: {
    type: Boolean,
    default: false
  },
  
  // Champs existants
  city: String,
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
  refreshTokens: [{
    type: String,
    select: false
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index
userSchema.index({ phoneNumber: 1 });
userSchema.index({ email: 1 });
userSchema.index({ googleId: 1 });
userSchema.index({ pseudo: 1 });
userSchema.index({ referredBy: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ authProvider: 1 });

// Hash password avant sauvegarde (seulement si password existe)
userSchema.pre('save', async function(next) {
  // Ne hash que si password modifié ET existe
  if (!this.isModified('password') || !this.password) return next();
  
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Comparer mot de passe
userSchema.methods.comparePassword = async function(candidatePassword) {
  // Si pas de password (user Google), retourne false
  if (!this.password) return false;
  
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