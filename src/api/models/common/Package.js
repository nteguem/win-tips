const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
  name: {
    fr: {
      type: String,
      required: [true, 'Le nom en français est requis'],
      trim: true
    },
    en: {
      type: String,
      required: [true, 'Le nom en anglais est requis'],
      trim: true
    }
  },
  description: {
    fr: {
      type: String,
      trim: true
    },
    en: {
      type: String,
      trim: true
    }
  },
  
  // ===== NOUVEAU : PROMESSES DE COTES =====
  oddsPromise: {
    daily: {
      min: {
        type: Number,
        min: 1.01,
        default: null
      },
      max: {
        type: Number,
        min: 1.01,
        default: null,
        validate: {
          validator: function(value) {
            // Si max existe, il doit être >= min
            if (value && this.oddsPromise?.daily?.min) {
              return value >= this.oddsPromise.daily.min;
            }
            return true;
          },
          message: 'La cote max doit être supérieure ou égale à la cote min'
        }
      }
    },
    weekly: {
      min: {
        type: Number,
        min: 1.01,
        default: null
      },
      max: {
        type: Number,
        min: 1.01,
        default: null,
        validate: {
          validator: function(value) {
            // Si max existe, il doit être >= min
            if (value && this.oddsPromise?.weekly?.min) {
              return value >= this.oddsPromise.weekly.min;
            }
            return true;
          },
          message: 'La cote max hebdomadaire doit être supérieure ou égale à la cote min'
        }
      }
    }
  },
  // =========================================
  
  // ===== MODE DE PAIEMENT =====
  // 'money' : abonnement payé en argent via intégrateurs (`pricing` requis,
  //           `adsRequired` ignoré). C'est le mode historique.
  // 'ads'   : abonnement débloqué en regardant `adsRequired` pubs récompensées
  //           SSV-vérifiées (`pricing` ignoré, sera vide).
  // Les deux modes sont MUTUELLEMENT EXCLUSIFS au niveau du pack — l'admin
  // crée un pack distinct pour chaque mode (ex: "Pack Hebdo Cash" + "Pack
  // Hebdo Pubs"). La validation mutex se fait en pre-save.
  paymentMode: {
    type: String,
    enum: ['money', 'ads'],
    default: 'money',
    required: true
  },

  // Nombre de pubs récompensées requises pour débloquer ce pack quand
  // `paymentMode='ads'`. Doit être >= 1. Ignoré quand paymentMode='money'.
  adsRequired: {
    type: Number,
    min: 1,
    default: null
  },
  // =============================

  // Prix en devises locales. Map<currencyCode, amount>. REQUIS quand
  // `paymentMode='money'`, IGNORÉ quand `paymentMode='ads'`. La validation
  // conditionnelle est dans le pre-save (le champ Mongoose ne peut pas
  // dépendre d'un autre champ pour `required`).
  pricing: {
    type: Map,
    of: {
      type: Number,
      min: 0,
      validate: {
        validator: function(value) {
          return value >= 0;
        },
        message: 'Le prix doit être positif'
      }
    },
    default: undefined
  },
  duration: {
    type: Number,
    required: true,
    min: 1
  },
  categories: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Category'
  }],
  badge: {
    fr: {
      type: String,
      trim: true
    },
    en: {
      type: String,
      trim: true
    }
  },
  economy: {
    type: Map,
    of: {
      type: Number,
      min: 0,
      validate: {
        validator: function(value) {
          return value >= 0;
        },
        message: 'L\'économie doit être positive'
      }
    }
  },

  googleProductId: {
    type: String,
    trim: true,
    sparse: true  // Permet d'avoir plusieurs null mais empêche les doublons si valeur
  },

  googlePlanId: {
    monthly: {
      type: String,
      trim: true
    },
    quarterly: {
      type: String,
      trim: true
    }
  },

  availableOnGooglePlay: {
    type: Boolean,
    default: false
  },

  // ===== NOUVEAU CHAMP POUR DIFFÉRENCIER SUBSCRIPTIONS VS PRODUITS PONCTUELS =====
  googleProductType: {
    type: String,
    enum: ['SUBSCRIPTION', 'ONE_TIME_PRODUCT'],
    default: function() {
      // Si availableOnGooglePlay = true et googleProductId existe
      // On considère que c'est une SUBSCRIPTION (pour garder l'existant)
      if (this.availableOnGooglePlay && this.googleProductId) {
        return 'SUBSCRIPTION';
      }
      return null;
    }
  },
  // =============================================================================

  formationId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Formation'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index pour performance
packageSchema.index({ isActive: 1 });
packageSchema.index({ pricing: 1 });
packageSchema.index({ formationId: 1 });

// ===== NOUVELLES MÉTHODES POUR LES PROMESSES DE COTES =====
packageSchema.methods.hasDailyOddsPromise = function() {
  return this.oddsPromise?.daily?.min && this.oddsPromise?.daily?.max;
};

packageSchema.methods.hasWeeklyOddsPromise = function() {
  return this.oddsPromise?.weekly?.min && this.oddsPromise?.weekly?.max;
};

packageSchema.methods.getDailyOddsPromise = function() {
  if (!this.hasDailyOddsPromise()) return null;
  return {
    min: this.oddsPromise.daily.min,
    max: this.oddsPromise.daily.max,
    formatted: `${this.oddsPromise.daily.min} - ${this.oddsPromise.daily.max}`
  };
};

packageSchema.methods.getWeeklyOddsPromise = function() {
  if (!this.hasWeeklyOddsPromise()) return null;
  return {
    min: this.oddsPromise.weekly.min,
    max: this.oddsPromise.weekly.max,
    formatted: `${this.oddsPromise.weekly.min} - ${this.oddsPromise.weekly.max}`
  };
};
// ========================================================

// ===== MÉTHODES EXISTANTES =====
// Vérifier si c'est un produit ponctuel Google
packageSchema.methods.isGooglePlayOneTimeProduct = function() {
  return this.availableOnGooglePlay && this.googleProductType === 'ONE_TIME_PRODUCT';
};

// Vérifier si c'est un abonnement Google (avec rétrocompatibilité)
packageSchema.methods.isGooglePlaySubscription = function() {
  return this.availableOnGooglePlay && 
    (this.googleProductType === 'SUBSCRIPTION' || !this.googleProductType);
};
// =====================================

// Méthode existante
packageSchema.methods.getGooglePlayInfo = function() {
  if (!this.availableOnGooglePlay) {
    return null;
  }
  
  return {
    productId: this.googleProductId,
    plans: this.googlePlanId,
    available: true,
    productType: this.googleProductType || 'SUBSCRIPTION' // Rétrocompatibilité
  };
};

// Méthodes existantes
packageSchema.methods.setPricing = function(currency, price) {
  if (!this.pricing) {
    this.pricing = new Map();
  }
  this.pricing.set(currency.toUpperCase(), price);
  return this;
};

packageSchema.methods.getPricing = function(currency) {
  return this.pricing ? this.pricing.get(currency.toUpperCase()) : undefined;
};

packageSchema.methods.getAvailableCurrencies = function() {
  return this.pricing ? Array.from(this.pricing.keys()) : [];
};

// Méthode pour gérer l'economy
packageSchema.methods.setEconomy = function(currency, amount) {
  if (!this.economy) {
    this.economy = new Map();
  }
  this.economy.set(currency.toUpperCase(), amount);
  return this;
};

packageSchema.methods.getEconomy = function(currency) {
  return this.economy ? this.economy.get(currency.toUpperCase()) : undefined;
};

// Méthode pour formater selon la langue (MISE À JOUR)
packageSchema.methods.formatForLanguage = function(lang = 'fr') {
  const packageObj = this.toObject();
  
  // Formater la formation si elle est populée
  let formation = null;
  if (packageObj.formationId && typeof packageObj.formationId === 'object') {
    formation = {
      _id: packageObj.formationId._id,
      title: packageObj.formationId.title[lang] || packageObj.formationId.title.fr,
      description: packageObj.formationId.description[lang] || packageObj.formationId.description.fr,
      isActive: packageObj.formationId.isActive,
      createdAt: packageObj.formationId.createdAt,
      updatedAt: packageObj.formationId.updatedAt
    };
  }
  
  return {
    _id: packageObj._id,
    name: packageObj.name[lang] || packageObj.name.fr,
    description: packageObj.description ? (packageObj.description[lang] || packageObj.description.fr) : null,
    pricing: packageObj.pricing instanceof Map ? Object.fromEntries(packageObj.pricing) : packageObj.pricing,
    duration: packageObj.duration,
    categories: packageObj.categories,
    badge: packageObj.badge ? (packageObj.badge[lang] || packageObj.badge.fr) : null,
    economy: packageObj.economy instanceof Map ? Object.fromEntries(packageObj.economy) : packageObj.economy,

    // Mode de paiement + nb de pubs (si applicable)
    paymentMode: packageObj.paymentMode || 'money',
    adsRequired: packageObj.adsRequired ?? null,

    // ===== AJOUT DES PROMESSES DE COTES =====
    oddsPromise: {
      daily: packageObj.oddsPromise?.daily || null,
      weekly: packageObj.oddsPromise?.weekly || null
    },
    // ========================================

    formation: formation,
    formationId: typeof packageObj.formationId === 'object' ? packageObj.formationId._id : packageObj.formationId,
    isActive: packageObj.isActive,
    createdAt: packageObj.createdAt,
    availableOnGooglePlay: packageObj.availableOnGooglePlay || false,
    googleProductId: packageObj.googleProductId || null,
    googleProductType: packageObj.googleProductType || null,
    googlePlanId: packageObj.googlePlanId || null
  };
};

// toJSON amélioré
packageSchema.methods.toJSON = function() {
  const packageObj = this.toObject();
  delete packageObj.__v;
  
  // Convertir les Maps en objets normaux pour le JSON
  if (packageObj.pricing instanceof Map) {
    packageObj.pricing = Object.fromEntries(packageObj.pricing);
  }
  
  if (packageObj.economy instanceof Map) {
    packageObj.economy = Object.fromEntries(packageObj.economy);
  }
  
  return packageObj;
};

// Pre-save hook : validation devises + mutex paymentMode
packageSchema.pre('save', function(next) {
  // Validation 1 : codes devises (3 lettres majuscules)
  if (this.pricing) {
    for (let currency of this.pricing.keys()) {
      if (!/^[A-Z]{3}$/.test(currency)) {
        return next(new Error(`Code devise invalide: ${currency}. Doit être 3 lettres majuscules.`));
      }
    }
  }

  if (this.economy) {
    for (let currency of this.economy.keys()) {
      if (!/^[A-Z]{3}$/.test(currency)) {
        return next(new Error(`Code devise invalide pour economy: ${currency}. Doit être 3 lettres majuscules.`));
      }
    }
  }

  // Validation 2 : mutex paymentMode ↔ champs requis
  //   money → pricing requis (non vide), adsRequired interdit
  //   ads   → adsRequired requis (>=1), pricing interdit
  if (this.paymentMode === 'money') {
    if (!this.pricing || (this.pricing.size === 0)) {
      return next(new Error('paymentMode=money requiert au moins un prix dans `pricing`.'));
    }
    if (this.adsRequired != null) {
      // On efface silencieusement pour rester tolérant côté admin.
      this.adsRequired = null;
    }
  } else if (this.paymentMode === 'ads') {
    if (!this.adsRequired || this.adsRequired < 1) {
      return next(new Error('paymentMode=ads requiert `adsRequired >= 1`.'));
    }
    // On efface pricing/economy/googleProductId pour rester cohérent.
    if (this.pricing && this.pricing.size > 0) {
      this.pricing = new Map();
    }
    if (this.economy && this.economy.size > 0) {
      this.economy = new Map();
    }
    if (this.availableOnGooglePlay) {
      this.availableOnGooglePlay = false;
      this.googleProductId = undefined;
      this.googleProductType = null;
    }
  }

  next();
});

module.exports = mongoose.model('Package', packageSchema);