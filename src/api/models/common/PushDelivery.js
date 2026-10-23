// src/api/models/common/PushDelivery.js
//
// Verrou d'idempotence de bout en bout. C'est ce qui garantit qu'un utilisateur
// ne reçoit jamais deux fois le même message pendant la cohabitation OneSignal/FCM.

const mongoose = require('mongoose');

const pushDeliverySchema = new mongoose.Schema({
  // sha1(notificationId + deviceId) en base64url, tronqué à 22 caractères.
  // Stable : même notification + même device = même clé, quel que soit le
  // provider emprunté et quel que soit le nombre de tentatives.
  msgId: { type: String, required: true },

  appId: { type: String, required: true, lowercase: true, trim: true },
  notificationId: { type: String, required: true },
  deviceId: { type: String, required: true },

  provider: { type: String, enum: ['fcm', 'onesignal'] },

  status: {
    type: String,
    enum: ['queued', 'sent', 'acked', 'failed'],
    default: 'queued',
  },

  // Code d'erreur du provider (messaging/registration-token-not-registered…)
  code: String,
  // Only explicit negative per-recipient responses may be retried. A network
  // timeout or a queued/accepted message is never forcefully sent again.
  retrySafe: { type: Boolean, default: false },
  attempts: { type: Number, default: 1 },
  nextRetryAt: Date,

  sentAt: Date,
  // Renseigné par l'accusé de réception envoyé par l'app : c'est ce qui permet
  // de reconstruire gratuitement le "Confirmed Delivery" payant de OneSignal.
  ackAt: Date,

  // Purge automatique après 72 h, sinon la collection gonfle sans fin
  // (22 951 devices x plusieurs broadcasts par jour).
  expiresAt: { type: Date, default: () => new Date(Date.now() + 72 * 3600e3) },
}, { timestamps: true });

// LE verrou anti-doublon. Deux workers concurrents, deux crons qui se chevauchent,
// un retry HTTP, ou un admin qui resauvegarde un ticket — Ticket.js déclenche déjà
// des doubles broadcasts via son hook post('findOneAndUpdate') : un seul passe.
pushDeliverySchema.index({ msgId: 1 }, { unique: true });
pushDeliverySchema.index({ appId: 1, notificationId: 1, status: 1 });
pushDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PushDelivery', pushDeliverySchema);
