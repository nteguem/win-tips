/**
 * Cron de vérification des paiements Smobilpay (Maviance).
 *
 * Le webhook Maviance ne pointe pas vers ce serveur (il est enregistré sur
 * l'instance multi-tenant). Ce cron joue le rôle du webhook : il interroge
 * Maviance pour les transactions PENDING et déclenche la création de la
 * souscription quand un paiement est confirmé.
 *
 * Fréquence : toutes les 2 minutes. Le service applique un backoff par âge,
 * donc une transaction PENDING ne sera pas systématiquement vérifiée à
 * chaque tick (cf. smobilpayVerificationService.shouldCheckNow).
 */

const cron = require('node-cron');
const verificationService = require('../../api/services/user/smobilpayVerificationService');

const CRON_EXPRESSION = '*/2 * * * *'; // toutes les 2 minutes

let task = null;
let isRunning = false; // évite qu'un tick chevauche le précédent

function start() {
  if (task) {
    console.log('[SmobilpayVerificationJob] Déjà démarré');
    return task;
  }

  task = cron.schedule(CRON_EXPRESSION, async () => {
    if (isRunning) {
      console.log('[SmobilpayVerificationJob] Tick précédent encore en cours, skip');
      return;
    }
    isRunning = true;
    try {
      await verificationService.verifyAllPendingTransactions();
    } catch (error) {
      console.error('[SmobilpayVerificationJob] Erreur tick:', error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log(`[SmobilpayVerificationJob] Démarré (cron: ${CRON_EXPRESSION})`);
  return task;
}

function stop() {
  if (!task) return;
  task.stop();
  task = null;
  console.log('[SmobilpayVerificationJob] Arrêté');
}

module.exports = { start, stop };
