// src/api/models/common/WheelConfig.js
//
// Configuration globale de la roue. SINGLETON (un seul document, marqué
// `_singleton: 'wheel'`). Accès via `WheelConfig.getSingleton()`.

const mongoose = require('mongoose');

const WheelConfigSchema = new mongoose.Schema({
  // Marqueur d'unicité — index unique sur cette clé garantit le singleton.
  _singleton: { type: String, default: 'wheel', unique: true },

  // Kill-switch global de la feature
  wheelEnabled: { type: Boolean, default: true },

  // Coût en pubs récompensées pour 1 tour (configurable depuis l'admin)
  adsPerSpin: { type: Number, min: 0, default: 3 },

  // Cooldown entre 2 spins consécutifs en secondes (anti-bot)
  cooldownSec: { type: Number, min: 0, default: 5 },

  // Limite quotidienne de spins par user (anti-farm)
  dailyMaxSpinsPerUser: { type: Number, min: 1, default: 20 },

  // Seuil minimum de retrait du wallet (Map<currency, montant minimum>)
  withdrawalThresholds: {
    type: Map,
    of: Number,
    default: () => new Map([['XAF', 5000]])
  },

  // Devise par défaut pour les gains cash si non précisée sur le lot
  defaultCurrency: { type: String, default: 'XAF', uppercase: true }
}, { timestamps: true });

WheelConfigSchema.statics.getSingleton = async function () {
  // Upsert atomique : si deux requêtes arrivent simultanément, MongoDB garantit
  // qu'une seule création passe (l'autre fait juste une lecture).
  // `setDefaultsOnInsert` applique les valeurs `default` du schéma à l'insertion.
  return this.findOneAndUpdate(
    { _singleton: 'wheel' },
    { $setOnInsert: { _singleton: 'wheel' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

WheelConfigSchema.methods.toAdminJSON = function () {
  const obj = this.toObject();
  if (obj.withdrawalThresholds instanceof Map) {
    obj.withdrawalThresholds = Object.fromEntries(obj.withdrawalThresholds);
  }
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('WheelConfig', WheelConfigSchema);
