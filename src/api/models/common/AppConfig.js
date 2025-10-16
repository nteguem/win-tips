/**
 * @fileoverview Modèle de configuration par pays
 * Gère les paramètres spécifiques à chaque pays (devise, langue, paiement)
 */
const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema(
  {
countryCode: {
  type: String,
  required: [true, 'Le code pays est requis'],
  unique: true,
  uppercase: true,
  trim: true,
  minlength: 2,
  maxlength: 7,  // ← CHANGÉ : permet "DEFAULT" (7 caractères)
  validate: {
    validator: function(v) {
      // Accepter soit 2 lettres (codes pays) soit "DEFAULT"
      return v === 'DEFAULT' || v.length === 2;
    },
    message: 'Le code pays doit faire 2 caractères ou être "DEFAULT"'
  },
  index: true,
},
    countryName: {
      type: String,
      required: [true, 'Le nom du pays est requis'],
      trim: true,
    },
    currency: {
      type: String,
      required: [true, 'La devise est requise'],
      uppercase: true,
      trim: true,
      enum: ['XAF', 'XOF', 'CDF', 'GNF', 'GMD', 'USD', 'EUR'],
    },
    language: {
      type: String,
      required: [true, 'La langue est requise'],
      lowercase: true,
      trim: true,
      enum: ['fr', 'en'],
      default: 'fr',
    },
    phonePrefix: {
      type: String,
      required: [true, 'Le préfixe téléphonique est requis'],
      trim: true,
    },
    paymentProvider: {
      type: String,
      required: [true, 'Le fournisseur de paiement est requis'],
      lowercase: true,
      trim: true,
      enum: ['cinetpay', 'afribapay', 'smobilpay', 'googlepay'],
      default: 'googlepay',
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    metadata: {
      callingCode: {
        type: String,
        trim: true,
      },
      region: {
        type: String,
        trim: true,
        enum: ['Central Africa', 'West Africa', 'East Africa', 'North Africa', 'Southern Africa', 'Europe', 'Americas', 'Asia', 'Oceania', 'Other'],
      },
      timezone: {
        type: String,
        trim: true,
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Index pour recherche rapide
appConfigSchema.index({ countryCode: 1, isActive: 1 });

// Méthode statique pour obtenir la config par défaut
appConfigSchema.statics.getDefaultConfig = async function () {
  let defaultConfig = await this.findOne({ countryCode: 'DEFAULT' });

  if (!defaultConfig) {
    // Créer config par défaut si elle n'existe pas
    defaultConfig = await this.create({
      countryCode: 'DEFAULT',
      countryName: 'International',
      currency: 'USD',
      language: 'en',
      phonePrefix: '+1',
      paymentProvider: 'googlepay',
      isActive: true,
      metadata: {
        callingCode: '1',
        region: 'Other',
        timezone: 'UTC',
      },
    });
  }

  return defaultConfig;
};

// Méthode statique pour obtenir config par code pays
appConfigSchema.statics.getByCountryCode = async function (countryCode) {
  const config = await this.findOne({
    countryCode: countryCode.toUpperCase(),
    isActive: true,
  });

  // Si pas de config spécifique, retourner config par défaut
  if (!config) {
    return await this.getDefaultConfig();
  }

  return config;
};

// Méthode d'instance pour formater la réponse
appConfigSchema.methods.toClientJSON = function () {
  return {
    countryCode: this.countryCode,
    countryName: this.countryName,
    currency: this.currency,
    language: this.language,
    phonePrefix: this.phonePrefix,
    paymentProvider: this.paymentProvider,
  };
};

const AppConfig = mongoose.model('AppConfig', appConfigSchema);

module.exports = AppConfig;