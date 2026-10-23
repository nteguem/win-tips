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
  // Nom bilingue. Pattern aligné sur bigwin v2 : chaque document stocke
  // toutes les langues, et `formatForLanguage(lang)` aplatit avant l'envoi
  // au client. Plus de `unique` (impossible proprement sur un sous-objet).
  name: {
    fr: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true }
  },
  description: {
    fr: { type: String, default: '' },
    en: { type: String, default: '' }
  },
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

/**
 * Lit un champ i18n en tolérant l'ancien format (string brute, avant migration)
 * ET le nouveau format ({ fr, en }). Fallback : lang demandée → fr → en.
 */
function pickLang(field, lang) {
  if (field == null) return '';
  if (typeof field === 'string') return field;          // legacy non migré
  return field[lang] || field.fr || field.en || '';
}

/**
 * Aplatit la catégorie pour le client : `name` et `description` deviennent des
 * strings dans la langue demandée. Le mobile reçoit donc toujours du texte
 * simple — aucun changement requis côté app.
 */
CategorySchema.methods.formatForLanguage = function (lang = 'fr') {
  const obj = this.toObject();
  obj.name = pickLang(this.name, lang);
  obj.description = pickLang(this.description, lang);
  delete obj.__v;
  return obj;
};

// Helper statique réutilisable (ex: couponController qui imbrique la catégorie).
CategorySchema.statics.pickLang = pickLang;

module.exports = mongoose.model("Category", CategorySchema);
