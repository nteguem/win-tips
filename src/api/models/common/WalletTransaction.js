// src/api/models/common/WalletTransaction.js
//
// Mouvements du Wallet utilisateur. Ledger append-only (jamais modifié).

const mongoose = require('mongoose');

const WalletTransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // credit_wheel       : gain de la roue de la chance
  // debit_withdrawal   : retrait (V1 = manuel admin)
  // adjustment         : ajustement admin (correction)
  type: {
    type: String,
    enum: ['credit_wheel', 'debit_withdrawal', 'adjustment'],
    required: true
  },

  amount: { type: Number, required: true },          // > 0 pour credit, < 0 pour debit
  currency: { type: String, required: true, uppercase: true },

  source: {
    kind: { type: String, enum: ['wheel_spin', 'manual', 'system'], default: 'system' },
    ref: { type: mongoose.Schema.Types.ObjectId, default: null }
  },

  // pending → completed (V2 : AfribaPay payouts auront un statut pending)
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },

  description: { type: String, default: null },
  adminNotes: { type: String, default: null },

  // Snapshot du solde APRÈS opération (utile pour audit & reconstruction)
  balanceAfter: { type: Number, default: null }
}, { timestamps: true });

WalletTransactionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
