/**
 * Service de vérification des paiements KoraPay.
 *
 * Filet de sécurité après webhook/retour navigateur manquant. Une transaction
 * payée mais dont l'activation a échoué doit aussi être reprise, sans repayer.
 */

const KorapayTransaction = require('../../models/user/KorapayTransaction');
const korapayService = require('./KorapayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_AGE_MS = 5 * 60 * 1000;
const MID_AGE_MS = 30 * 60 * 1000;
const MID_INTERVAL_MS = 5 * 60 * 1000;
const LATE_INTERVAL_MS = 30 * 60 * 1000;
const CONCURRENCY = 5;

/**
 * Vérifie une transaction auprès de KoraPay et déclenche la création de
 * souscription si SUCCESS. Tolérant aux erreurs.
 */
async function verifyOne(transaction) {
  try {
    transaction.checkAttempts = (transaction.checkAttempts || 0) + 1;
    transaction.lastCheckedAt = new Date();
    await transaction.save();

    const reference = transaction.reference || transaction.korapayReference || transaction.transactionId;
    const updated = await korapayService.checkTransactionStatus(reference);
    const subscription = await paymentMiddleware.processTransactionUpdate(updated);
    return { transaction: updated, subscription };
  } catch (error) {
    console.error(
      `[KorapayVerification] Échec vérification ${transaction.transactionId}:`,
      error.message
    );
    return null;
  }
}

function shouldCheckNow(transaction, now = Date.now()) {
  const age = now - new Date(transaction.createdAt).getTime();
  if (transaction.status !== 'SUCCESS' && age >= MAX_AGE_MS) return false;

  const lastCheck = transaction.lastCheckedAt
    ? new Date(transaction.lastCheckedAt).getTime()
    : 0;
  const sinceLastCheck = now - lastCheck;

  if (age <= RECENT_AGE_MS) return true;
  if (age <= MID_AGE_MS) return sinceLastCheck >= MID_INTERVAL_MS;
  return sinceLastCheck >= LATE_INTERVAL_MS;
}

async function runWithConcurrency(items, worker, concurrency = CONCURRENCY) {
  const results = [];
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => next()
  );
  await Promise.all(workers);
  return results;
}

async function expireOldPending() {
  // An elapsed local timer is not evidence of failure at the payment provider.
  // Old pending payments remain recoverable by status/callback/webhook.
  return 0;
}

function recoveryQuery(userId) {
  return {
    ...(userId ? { user: userId } : {}),
    processed: false,
    $or: [
      { status: 'SUCCESS' },
      { status: { $in: ['PENDING', 'PROCESSING', 'EXPIRED'] }, createdAt: { $gte: new Date(Date.now() - MAX_AGE_MS) } },
    ],
  };
}

async function verifyUserPendingTransactions(userId) {
  const pending = await KorapayTransaction.find(recoveryQuery(userId));

  if (pending.length === 0) return [];
  return runWithConcurrency(pending, verifyOne);
}

async function verifyAllPendingTransactions() {
  const candidates = await KorapayTransaction.find(recoveryQuery());

  const now = Date.now();
  const toCheck = candidates.filter(tx => shouldCheckNow(tx, now));

  if (toCheck.length === 0) return { scanned: candidates.length, checked: 0, succeeded: 0 };

  const results = await runWithConcurrency(toCheck, verifyOne);
  const succeeded = results.filter(r => r?.subscription).length;

  console.log(
    `[KorapayVerification] Scan terminé: candidates=${candidates.length} checked=${toCheck.length} succeeded=${succeeded}`
  );

  return { scanned: candidates.length, checked: toCheck.length, succeeded };
}

module.exports = {
  verifyUserPendingTransactions,
  verifyAllPendingTransactions,
  shouldCheckNow,
  expireOldPending,
  recoveryQuery,
};
