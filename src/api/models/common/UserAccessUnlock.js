// src/api/models/common/UserAccessUnlock.js
//
// Suivi du déblocage d'une ressource (aujourd'hui : une Category free de
// coupons) par visionnage de pubs récompensées AdMob, vérifiées via SSV.
// Débloquer la catégorie ⇒ tous ses coupons sont accessibles pendant la durée.
//
// Un seul document par couple (user, resourceType, resource). Le cycle de vie :
//   1. startOrSwitchUnlock → crée/réinitialise le doc en `in_progress` avec
//      `selectedOption` (durée + nb de pubs) et un `nonce` neuf.
//   2. chaque callback SSV vérifié → `recordVerifiedReward` incrémente
//      `verifiedCount` (atomique, dédup sur `rewards.transactionId`).
//   3. quand `verifiedCount >= selectedOption.adsRequired` → `unlocked`,
//      `unlockedAt = now`, `expiresAt = unlockedAt + durationMinutes`
//      (null si l'offre est "à vie").
//   4. une fois `expiresAt` passé, l'accès n'est plus actif ; le doc est
//      réinitialisé au prochain startOrSwitchUnlock.
//
// La progression partielle (in_progress, seuil pas encore atteint) est
// conservée et reportée si l'utilisateur change d'offre.

const mongoose = require('mongoose');

/**
 * Récompense vérifiée reçue via le callback SSV AdMob.
 * `transactionId` sert de clé de déduplication.
 */
const VerifiedRewardSchema = new mongoose.Schema({
  transactionId: { type: String, required: true },
  adUnitId: { type: String, default: null },
  adNetwork: { type: String, default: null },
  rewardAmount: { type: Number, default: null },
  rewardItem: { type: String, default: null },
  rewardedAt: { type: Date, default: null },
  receivedAt: { type: Date, default: Date.now }
}, { _id: false });

const UserAccessUnlockSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  resourceType: {
    type: String,
    enum: ['category'],
    default: 'category'
  },

  resource: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },

  status: {
    type: String,
    enum: ['in_progress', 'unlocked'],
    default: 'in_progress'
  },

  selectedOption: {
    durationMinutes: { type: Number, default: null }, // null ⇒ à vie
    adsRequired: { type: Number, default: null }
  },

  verifiedCount: { type: Number, default: 0 },

  // Jeton opaque transmis dans le `custom_data` de la pub : relie les
  // callbacks SSV à cette tentative. Régénéré à chaque (re)démarrage.
  nonce: { type: String, default: null, index: true },

  unlockedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }, // null = à vie OU pas (encore) débloqué

  rewards: { type: [VerifiedRewardSchema], default: [] }
}, { timestamps: true });

UserAccessUnlockSchema.index(
  { user: 1, resourceType: 1, resource: 1 },
  { unique: true }
);
UserAccessUnlockSchema.index({ user: 1, status: 1 });

UserAccessUnlockSchema.methods.isAccessActive = function () {
  if (this.status !== 'unlocked') return false;
  if (!this.expiresAt) return true;
  return this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model('UserAccessUnlock', UserAccessUnlockSchema);
