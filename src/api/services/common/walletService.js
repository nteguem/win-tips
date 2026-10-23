// src/api/services/common/walletService.js
//
// Service Wallet — créditer/débiter le solde utilisateur avec ledger
// (WalletTransaction). En V1, les débits (retraits) sont marqués `pending` et
// validés manuellement par l'admin. V2 intégrera AfribaPay payouts.

const Wallet = require('../../models/common/Wallet');
const WalletTransaction = require('../../models/common/WalletTransaction');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

async function getOrCreateWallet(userId) {
  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) wallet = await Wallet.create({ user: userId });
  return wallet;
}

/**
 * Crédite le wallet de l'user. Crée une WalletTransaction (type=credit_wheel).
 * @returns {{wallet, transaction}}
 */
async function credit({ userId, amount, currency, source, description }) {
  if (!amount || amount <= 0) {
    throw new AppError('Montant invalide pour un crédit.', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const curr = String(currency || 'XAF').toUpperCase();

  const wallet = await getOrCreateWallet(userId);
  const current = wallet.balances.get(curr) || 0;
  const newBalance = current + amount;
  wallet.balances.set(curr, newBalance);

  const totalEarned = (wallet.totalEarned.get(curr) || 0) + amount;
  wallet.totalEarned.set(curr, totalEarned);

  await wallet.save();

  const tx = await WalletTransaction.create({
    user: userId,
    type: 'credit_wheel',
    amount,
    currency: curr,
    source: source || { kind: 'system' },
    status: 'completed',
    description: description || null,
    balanceAfter: newBalance
  });

  return { wallet, transaction: tx };
}

/**
 * Demande de retrait — V1 manuel admin. Crée une WalletTransaction
 * status='pending' avec montant négatif. L'admin la marque 'completed'
 * une fois le paiement effectué hors app.
 */
async function requestWithdrawal({ userId, amount, currency, description }) {
  if (!amount || amount <= 0) {
    throw new AppError('Montant invalide pour un retrait.', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const curr = String(currency || 'XAF').toUpperCase();

  const wallet = await getOrCreateWallet(userId);
  const current = wallet.balances.get(curr) || 0;
  if (current < amount) {
    throw new AppError('Solde insuffisant.', 400, ErrorCodes.OPERATION_NOT_ALLOWED);
  }

  // On débite IMMÉDIATEMENT le solde (block d'un double retrait), la TX est pending
  const newBalance = current - amount;
  wallet.balances.set(curr, newBalance);
  await wallet.save();

  const tx = await WalletTransaction.create({
    user: userId,
    type: 'debit_withdrawal',
    amount: -amount,
    currency: curr,
    source: { kind: 'manual' },
    status: 'pending',
    description: description || 'Demande de retrait',
    balanceAfter: newBalance
  });

  return { wallet, transaction: tx };
}

/**
 * Validation admin du retrait : marque la TX completed et incrémente totalWithdrawn.
 */
async function completeWithdrawal({ transactionId, adminNotes }) {
  const tx = await WalletTransaction.findById(transactionId);
  if (!tx) throw new AppError('Transaction introuvable.', 404, ErrorCodes.NOT_FOUND);
  if (tx.type !== 'debit_withdrawal') {
    throw new AppError('TX non éligible.', 400, ErrorCodes.OPERATION_NOT_ALLOWED);
  }
  if (tx.status === 'completed') return tx;

  tx.status = 'completed';
  if (adminNotes) tx.adminNotes = adminNotes;
  await tx.save();

  const wallet = await getOrCreateWallet(tx.user);
  const totalW = (wallet.totalWithdrawn.get(tx.currency) || 0) + Math.abs(tx.amount);
  wallet.totalWithdrawn.set(tx.currency, totalW);
  await wallet.save();

  return tx;
}

/**
 * Annulation d'un retrait pending (refund au wallet).
 */
async function cancelWithdrawal({ transactionId, adminNotes }) {
  const tx = await WalletTransaction.findById(transactionId);
  if (!tx) throw new AppError('Transaction introuvable.', 404, ErrorCodes.NOT_FOUND);
  if (tx.status !== 'pending' || tx.type !== 'debit_withdrawal') {
    throw new AppError('TX non annulable.', 400, ErrorCodes.OPERATION_NOT_ALLOWED);
  }
  // Refund
  const wallet = await getOrCreateWallet(tx.user);
  const restored = (wallet.balances.get(tx.currency) || 0) + Math.abs(tx.amount);
  wallet.balances.set(tx.currency, restored);
  await wallet.save();

  tx.status = 'failed';
  if (adminNotes) tx.adminNotes = adminNotes;
  tx.balanceAfter = restored;
  await tx.save();

  return tx;
}

async function getWalletView(userId) {
  const wallet = await getOrCreateWallet(userId);
  return wallet.toPublicJSON();
}

async function listTransactions(userId, { limit = 20, skip = 0 } = {}) {
  return WalletTransaction.find({ user: userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Math.min(limit, 100));
}

module.exports = {
  getOrCreateWallet,
  credit,
  requestWithdrawal,
  completeWithdrawal,
  cancelWithdrawal,
  getWalletView,
  listTransactions
};
