// src/api/models/common/WheelUserStats.js
//
// Stats par user pour la roue : tours gratuits accumulés, dernier spin (pour
// cooldown), compteur total. Créé à la 1re interaction (lazy via getOrCreate).

const mongoose = require('mongoose');

const WheelUserStatsSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Solde de TOURS disponibles. L'user gagne des tours en regardant des pubs
  // via un pack (ticketPacks configurables). Chaque spin consomme 1 tour.
  // C'est la "monnaie interne" de la roue.
  ticketsBalance: { type: Number, default: 0, min: 0 },

  // Compteur total de tickets gagnés (jamais décrémenté — pour stats)
  totalTicketsEarned: { type: Number, default: 0 },

  rewardedCredits: { type: [{ nonce: String, tickets: Number, creditedAt: Date, _id: false }], default: [], select: false },
  lastRewardedNonce: { type: String, default: null },
  lastRewardedTickets: { type: Number, default: 0 },

  lastSpinAt: { type: Date, default: null },
  totalSpins: { type: Number, default: 0 }
}, { timestamps: true });

WheelUserStatsSchema.statics.getOrCreate = async function (userId) {
  let doc = await this.findOne({ user: userId });
  if (!doc) {
    try { doc = await this.create({ user: userId }); }
    catch (error) {
      if (error.code !== 11000) throw error;
      doc = await this.findOne({ user: userId });
    }
  }
  return doc;
};

module.exports = mongoose.model('WheelUserStats', WheelUserStatsSchema);
