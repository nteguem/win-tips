/**
 * Cron de verification des paiements pawaPay.
 *
 * Les webhooks pawaPay sont peu fiables (retards/pertes). Ce cron joue le
 * role de filet de securite : il interroge pawaPay pour les transactions
 * en attente (PENDING/INITIATED) et declenche la creation de la souscription
 * quand un paiement est confirme.
 *
 * Frequence : toutes les 2 minutes. Le service applique un backoff par age,
 * donc une transaction en attente n'est pas systematiquement verifiee a
 * chaque tick (cf. pawapayVerificationService.shouldCheckNow).
 */

const cron = require('node-cron');
const verificationService = require('../../api/services/user/pawapayVerificationService');

const CRON_EXPRESSION = '*/2 * * * *'; // toutes les 2 minutes

let task = null;
let isRunning = false; // evite qu'un tick chevauche le precedent

function start() {
  if (task) {
    console.log('[PawapayVerificationJob] Deja demarre');
    return task;
  }

  task = cron.schedule(CRON_EXPRESSION, async () => {
    if (isRunning) {
      console.log('[PawapayVerificationJob] Tick precedent encore en cours, skip');
      return;
    }
    isRunning = true;
    try {
      await verificationService.verifyAllPendingTransactions();
    } catch (error) {
      console.error('[PawapayVerificationJob] Erreur tick:', error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log(`[PawapayVerificationJob] Demarre (cron: ${CRON_EXPRESSION})`);
  return task;
}

function stop() {
  if (!task) return;
  task.stop();
  task = null;
  console.log('[PawapayVerificationJob] Arrete');
}

module.exports = { start, stop };
