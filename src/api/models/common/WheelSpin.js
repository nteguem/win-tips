// src/api/models/common/WheelSpin.js
//
// Historique des spins de la roue. Un document par tour terminé (lot tiré).
// L'idempotence est garantie par l'index unique sur `unlockId` : un même
// UserAccessUnlock ne peut produire qu'un seul WheelSpin.

const mongoose = require('mongoose');

const WheelSpinSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  prize: { type: mongoose.Schema.Types.ObjectId, ref: 'WheelPrize', default: null, index: true },

  // Snapshot du lot au moment du gain — résistant aux modifications admin
  // ultérieures (renommage, suppression, changement de montant cash, etc.)
  prizeSnapshot: {
    name: { fr: String, en: String },
    type: { type: String },
    cash: { amount: Number, currency: String },
    physical: { label: String },
    subscription: {
      packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
      durationHours: Number
    },
    freeSpin: { count: Number }
  },

  // Référence à l'unlock qui a généré ce spin — pour audit.
  // Dans le NOUVEAU FLOW (V2 tickets), le spin est synchrone et n'utilise pas
  // d'UserAccessUnlock — ce champ est donc nullable. Les anciens spins gardent
  // leur unlockId pour traçabilité.
  unlockId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserAccessUnlock',
    default: null,
    index: true
  },

  // Nonce du cycle de spin — UNIQUE et change à chaque start(). C'est lui qui
  // garantit l'idempotence du finalize(), pas l'unlockId (qui est réutilisé).
  nonce: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  adsRequired: { type: Number, default: 0 },
  wasFreeSpin: { type: Boolean, default: false },

  // Cycle de vie :
  //   won              : lot tiré (état initial transitoire)
  //   claimed_auto     : crédit auto réussi (cash → wallet | sub créée | free spin crédité | dommage)
  //   pending_delivery : lot physique en attente de livraison admin
  //   delivered        : lot physique livré (admin a marqué)
  //   paid             : cash payé hors app (admin a marqué)
  status: {
    type: String,
    enum: ['won', 'claimed_auto', 'pending_delivery', 'delivered', 'paid'],
    default: 'won'
  },

  // Référence wallet transaction si cash crédité automatiquement
  walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },

  // Référence subscription créée si lot type=subscription
  subscriptionCreated: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },

  // Notes admin (motif livraison, no transaction MoMo, etc.)
  adminNotes: { type: String, default: null }
}, { timestamps: true });

WheelSpinSchema.index({ user: 1, createdAt: -1 });
WheelSpinSchema.index({ prize: 1, createdAt: -1 });
WheelSpinSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('WheelSpin', WheelSpinSchema);
