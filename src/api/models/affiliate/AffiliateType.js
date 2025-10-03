const mongoose = require('mongoose');

const affiliateTypeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Le nom du type d\'affilié est requis'],
    unique: true,
    trim: true,
    enum: {
      values: ['AMBASSADEUR', 'TEAM LEADER', 'ELITE PARTNER'],
      message: 'Le type d\'affilié doit être AMBASSADEUR, TEAM LEADER ou ELITE PARTNER'
    }
  },
  
  description: {
    type: String,
    required: [true, 'La description est requise'],
    trim: true
  },
  
  minAccounts: {
    type: Number,
    required: [true, 'Le nombre minimum de comptes est requis'],
    min: [0, 'Le nombre minimum de comptes ne peut pas être négatif']
  },
  
  commissionRate: {
    type: Number,
    required: [true, 'Le taux de commission est requis']
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Middleware pour mettre à jour updatedAt avant chaque sauvegarde
affiliateTypeSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.updatedAt = Date.now();
  }
  next();
});

// Middleware pour mettre à jour updatedAt lors des mises à jour
affiliateTypeSchema.pre(['updateOne', 'findOneAndUpdate'], function(next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Index pour optimiser les requêtes
affiliateTypeSchema.index({ name: 1 });
affiliateTypeSchema.index({ minAccounts: 1 });
affiliateTypeSchema.index({ isActive: 1 });

// Méthode statique pour obtenir le type d'affilié basé sur le nombre de comptes
affiliateTypeSchema.statics.getTypeByAccountCount = async function(accountCount) {
  const types = await this.find({ isActive: true })
    .sort({ minAccounts: -1 }); // Trier du plus grand au plus petit
  
  for (const type of types) {
    if (accountCount >= type.minAccounts) {
      return type;
    }
  }
  
  return null; // Aucun type trouvé
};

// Méthode d'instance pour calculer la commission
affiliateTypeSchema.methods.calculateCommission = function(amount) {
  return (amount * this.commissionRate) / 100;
};

const AffiliateType = mongoose.model('AffiliateType', affiliateTypeSchema);

module.exports = AffiliateType;