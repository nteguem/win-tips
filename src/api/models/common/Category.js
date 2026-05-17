const mongoose = require("mongoose");

/**
 * Une offre de déblocage : visionner `adsRequired` pubs récompensées donne
 * accès à tous les coupons de la catégorie pendant `durationMinutes` minutes
 * (null = à vie).
 */
const AccessGateOptionSchema = new mongoose.Schema({
  durationMinutes: { type: Number, default: null, min: 1 },
  adsRequired: { type: Number, required: true, min: 1 }
}, { _id: false });

/**
 * Porte de déblocage par visionnage de pubs récompensées (AdMob rewarded + SSV),
 * portée par la CATÉGORIE : tous les coupons de la catégorie en héritent.
 * Sous-document optionnel : absent ⇒ catégorie en accès libre.
 * Ne concerne que les catégories free (l'API ne l'évalue que côté non-VIP).
 */
const AccessGateSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['ad_reward'],
    required: true
  },
  options: {
    type: [AccessGateOptionSchema],
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: 'accessGate.options doit contenir au moins une offre'
    }
  }
}, { _id: false });

const CategorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  description: String,
  icon: {
    type: String,
    default: "🧾"
  },
  successRate: {
    type: Number,
    default: 50,
    min: 0,
    max: 100,
    validate: {
      validator: function(v) {
        return v >= 0 && v <= 100;
      },
      message: 'Success rate must be between 0 and 100'
    }
  },
  isVip: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },

  // Porte de déblocage par pub appliquée à TOUS les coupons de cette catégorie.
  // Absent ⇒ catégorie en accès libre. Pour retirer la porte : `accessGate: null`.
  accessGate: {
    type: AccessGateSchema,
    default: undefined
  },

  // Sources externes : liste des categories d'autres systemes (bigwin et
  // ses apps multi-tenant) dont les tickets publies seront automatiquement
  // clones dans CETTE categorie wintips.
  //
  // Exemple : "Pass Decouverte" wintips veut absorber les CDJ de bigwin
  //           -> externalSources = [{ system:'bigwin', appId:'bigwin',
  //                                   categoryId:'688f4b53...' }]
  //
  // Si vide => aucun ticket externe ne sera clone dans cette categorie.
  externalSources: {
    type: [{
      system: { type: String, required: true },     // ex: 'bigwin'
      appId: { type: String, required: true },      // ex: 'bigwin', 'goatips'...
      categoryId: { type: String, required: true }, // ObjectId source en string
      // libelle humain optionnel pour faciliter le debug + affichage UI
      label: { type: String, default: '' },
      _id: false,
    }],
    default: [],
  },
}, {
  timestamps: true
});

// Index multikey pour la resolution rapide a chaque publication
// (find one Category where externalSources matches {system,appId,categoryId})
CategorySchema.index({
  'externalSources.system': 1,
  'externalSources.appId': 1,
  'externalSources.categoryId': 1,
});

module.exports = mongoose.model("Category", CategorySchema);
