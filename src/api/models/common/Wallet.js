// src/api/models/common/Wallet.js
//
// Wallet utilisateur — soldes par devise. Créé à la 1re opération (lazy).
// Mouvements tracés dans WalletTransaction.

const mongoose = require('mongoose');

const WalletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Map<currencyCode, balance>
  balances: {
    type: Map,
    of: { type: Number, default: 0 },
    default: () => new Map()
  },

  // Totaux cumulés (jamais décrémentés — utile pour stats)
  totalEarned: { type: Map, of: Number, default: () => new Map() },
  totalWithdrawn: { type: Map, of: Number, default: () => new Map() }
}, { timestamps: true });

WalletSchema.methods.getBalance = function (currency) {
  return this.balances.get(String(currency).toUpperCase()) || 0;
};

WalletSchema.methods.toPublicJSON = function () {
  const obj = this.toObject();
  const toObj = m => (m instanceof Map ? Object.fromEntries(m) : (m || {}));
  return {
    balances: toObj(obj.balances),
    totalEarned: toObj(obj.totalEarned),
    totalWithdrawn: toObj(obj.totalWithdrawn),
    updatedAt: obj.updatedAt
  };
};

module.exports = mongoose.model('Wallet', WalletSchema);
