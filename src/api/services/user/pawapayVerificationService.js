/**
 * Service de verification des paiements pawaPay.
 *
 * Ce service rattrape un webhook manquant et une activation interrompue.
 * Il vérifie le paiement auprès de pawaPay, puis utilise le règlement partagé
 * idempotent ; une preuve de succès persistée reste utilisable après panne.
 *
 * Deux entrees :
 *  - verifyUserPendingTransactions(userId) : branchee sur /me pour rattraper
 *    instantanement les paiements en attente de l'utilisateur connecte.
 *  - verifyAllPendingTransactions() : appelee par le cron, scanne toutes les
 *    transactions en attente avec un backoff progressif par age.
 */

const PawapayTransaction = require('../../models/user/PawapayTransaction');
const pawapayService = require('./PawapayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');

// Statuts "en attente" a scanner (non finalises)
const PENDING_STATUSES = ['PENDING', 'INITIATED'];

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // fenêtre du scan automatique
const RECENT_AGE_MS = 5 * 60 * 1000;          // 0-5 min : check a chaque tick
const MID_AGE_MS = 30 * 60 * 1000;            // 5-30 min : check toutes les 5 min
const MID_INTERVAL_MS = 5 * 60 * 1000;
const LATE_INTERVAL_MS = 30 * 60 * 1000;      // > 30 min : check toutes les 30 min
const CONCURRENCY = 5;                        // requetes pawaPay simultanees max

/**
 * Verifier UNE transaction aupres de pawaPay et declencher la creation de
 * souscription si SUCCESS. Tolerant aux erreurs (log + return null).
 *
 * On horodate AVANT l'appel API pour que le backoff tienne meme si pawaPay
 * repond en erreur (evite de re-frapper l'API a chaque tick).
 */
async function verifyOne(transaction) {
  try {
    transaction.checkAttempts = (transaction.checkAttempts || 0) + 1;
    transaction.lastCheckedAt = new Date();
    await transaction.save();

    const updated = await pawapayService.checkTransactionStatus(transaction.depositId);
    const subscription = await paymentMiddleware.processTransactionUpdate(updated);
    return { transaction: updated, subscription };
  } catch (error) {
    console.error(
      `[PawapayVerification] Echec verification ${transaction.depositId}:`,
      error.message
    );
    return null;
  }
}

/**
 * Decide si une transaction en attente doit etre (re)verifiee maintenant
 * en fonction de son age et de la derniere verification.
 */
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

/**
 * Execute une fonction async sur un tableau avec une concurrence limitee.
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
 * Conservé pour compatibilité. Un délai local ne prouve pas l'échec du PSP.
 */
async function expireOldPending() {
  return 0;
}

function recoveryQuery(userId) {
  return {
    ...(userId ? { user: userId } : {}),
    processed: false,
    $or: [
      { status: 'SUCCESS' },
      { status: { $in: [...PENDING_STATUSES, 'EXPIRED'] }, createdAt: { $gte: new Date(Date.now() - MAX_AGE_MS) } },
    ],
  };
}

/**
 * Verifie les transactions en attente d'un utilisateur precis.
 * Appelee depuis /me pour donner une reponse instantanee a l'utilisateur
 * qui ouvre l'app apres avoir paye.
 */
async function verifyUserPendingTransactions(userId) {
  const pending = await PawapayTransaction.find(recoveryQuery(userId));

  if (pending.length === 0) return [];

  return runWithConcurrency(pending, verifyOne);
}

/**
 * Scan global utilise par le cron. Applique le backoff par age et
 * reprend aussi les règlements payés mais non activés.
 */
async function verifyAllPendingTransactions() {
  const candidates = await PawapayTransaction.find(recoveryQuery());

  const now = Date.now();
  const toCheck = candidates.filter(tx => shouldCheckNow(tx, now));

  if (toCheck.length === 0) return { scanned: candidates.length, checked: 0, succeeded: 0 };

  const results = await runWithConcurrency(toCheck, verifyOne);
  const succeeded = results.filter(r => r?.subscription).length;

  console.log(
    `[PawapayVerification] Scan termine: candidates=${candidates.length} checked=${toCheck.length} succeeded=${succeeded}`
  );

  return { scanned: candidates.length, checked: toCheck.length, succeeded };
}

module.exports = {
  verifyUserPendingTransactions,
  verifyAllPendingTransactions,
  // exporte pour les tests
  shouldCheckNow,
  expireOldPending,
  recoveryQuery
};
