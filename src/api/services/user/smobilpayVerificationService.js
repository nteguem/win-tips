/**
 * Service de vérification des paiements Smobilpay (Maviance).
 *
 * Le webhook Maviance n'arrive jamais sur ce serveur (il est configuré
 * pour pointer vers l'instance multi-tenant). Ce service compense en
 * interrogeant activement l'API Maviance pour les transactions PENDING
 * et en créant la souscription via paymentMiddleware.processTransactionUpdate
 * (idempotent grâce au flag `processed`).
 *
 * Deux entrées :
 *  - verifyUserPendingTransactions(userId) : à brancher sur /me pour rattraper
 *    instantanément les paiements en attente de l'utilisateur connecté.
 *  - verifyAllPendingTransactions() : appelé par le cron, scanne toutes les
 *    transactions PENDING avec un backoff progressif.
 */

const SmobilpayTransaction = require('../../models/user/SmobilpayTransaction');
const smobilpayService = require('./SmobilpayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;      // 24 h : au-delà on EXPIRE
const RECENT_AGE_MS = 5 * 60 * 1000;          // 0-5 min : check à chaque tick
const MID_AGE_MS = 30 * 60 * 1000;            // 5-30 min : check toutes les 5 min
const MID_INTERVAL_MS = 5 * 60 * 1000;
const LATE_INTERVAL_MS = 30 * 60 * 1000;      // > 30 min : check toutes les 30 min
const CONCURRENCY = 5;                        // requêtes Maviance simultanées max

/**
 * Vérifier UNE transaction auprès de Maviance et déclencher la création de
 * souscription si SUCCESS. Tolérant aux erreurs (log + return null).
 */
async function verifyOne(transaction) {
  try {
    transaction.checkAttempts = (transaction.checkAttempts || 0) + 1;
    transaction.lastCheckedAt = new Date();
    await transaction.save();

    const updated = await smobilpayService.checkTransactionStatus(transaction.paymentId);
    const subscription = await paymentMiddleware.processTransactionUpdate(updated);
    return { transaction: updated, subscription };
  } catch (error) {
    console.error(
      `[SmobilpayVerification] Échec vérification ${transaction.paymentId}:`,
      error.message
    );
    return null;
  }
}

/**
 * Décide si une transaction PENDING doit être (re)vérifiée maintenant
 * en fonction de son âge et de la dernière vérification.
 */
function shouldCheckNow(transaction, now = Date.now()) {
  const age = now - new Date(transaction.createdAt).getTime();
  if (age >= MAX_AGE_MS) return false; // gérée séparément (EXPIRED)

  const lastCheck = transaction.lastCheckedAt
    ? new Date(transaction.lastCheckedAt).getTime()
    : 0;
  const sinceLastCheck = now - lastCheck;

  if (age <= RECENT_AGE_MS) return true;
  if (age <= MID_AGE_MS) return sinceLastCheck >= MID_INTERVAL_MS;
  return sinceLastCheck >= LATE_INTERVAL_MS;
}

/**
 * Exécute une fonction async sur un tableau avec une concurrence limitée.
 */
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

/**
 * Marque les transactions PENDING de plus de 24h comme EXPIRED pour qu'elles
 * sortent du scan du cron.
 */
async function expireOldPending() {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);
  const result = await SmobilpayTransaction.updateMany(
    { status: 'PENDING', processed: false, createdAt: { $lt: cutoff } },
    { $set: { status: 'EXPIRED' } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[SmobilpayVerification] ${result.modifiedCount} transactions expirées`);
  }
  return result.modifiedCount;
}

/**
 * Vérifie les transactions PENDING d'un utilisateur précis.
 * Appelée depuis /me pour donner une réponse instantanée à l'utilisateur
 * qui ouvre l'app après avoir payé.
 *
 * On limite aux transactions créées dans les dernières 24h pour éviter
 * de re-frapper l'API Maviance pour des transactions abandonnées.
 */
async function verifyUserPendingTransactions(userId) {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);
  const pending = await SmobilpayTransaction.find({
    user: userId,
    status: 'PENDING',
    processed: false,
    createdAt: { $gte: cutoff }
  });

  if (pending.length === 0) return [];

  return runWithConcurrency(pending, verifyOne);
}

/**
 * Scan global utilisé par le cron. Applique le backoff par âge et
 * expire les transactions trop vieilles.
 */
async function verifyAllPendingTransactions() {
  await expireOldPending();

  const cutoff = new Date(Date.now() - MAX_AGE_MS);
  const candidates = await SmobilpayTransaction.find({
    status: 'PENDING',
    processed: false,
    createdAt: { $gte: cutoff }
  });

  const now = Date.now();
  const toCheck = candidates.filter(tx => shouldCheckNow(tx, now));

  if (toCheck.length === 0) return { scanned: candidates.length, checked: 0, succeeded: 0 };

  const results = await runWithConcurrency(toCheck, verifyOne);
  const succeeded = results.filter(r => r?.subscription).length;

  console.log(
    `[SmobilpayVerification] Scan terminé: candidates=${candidates.length} checked=${toCheck.length} succeeded=${succeeded}`
  );

  return { scanned: candidates.length, checked: toCheck.length, succeeded };
}

module.exports = {
  verifyUserPendingTransactions,
  verifyAllPendingTransactions,
  // exporté pour les tests
  shouldCheckNow,
  expireOldPending
};
