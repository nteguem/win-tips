// src/api/models/common/WheelUserStats.js
//
// Stats par user pour la roue : tours gratuits accumulés, dernier spin (pour
// cooldown), compteur total. Créé à la 1re interaction (lazy via getOrCreate).

const mongoose = require('mongoose');

const WheelUserStatsSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Tours gratuits accumulés (gagnés via prize de type free_spin).
  // Consommés en priorité au prochain spin (avant de demander des pubs).
  freeSpinsRemaining: { type: Number, default: 0, min: 0 },

  lastSpinAt: { type: Date, default: null },
  totalSpins: { type: Number, default: 0 }
}, { timestamps: true });

WheelUserStatsSchema.statics.getOrCreate = async function (userId) {
  let doc = await this.findOne({ user: userId });
  if (!doc) doc = await this.create({ user: userId });
  return doc;
};

module.exports = mongoose.model('WheelUserStats', WheelUserStatsSchema);
