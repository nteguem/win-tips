/**
 * Cron de vérification des paiements KoraPay.
 *
 * Le webhook KoraPay n'est pas utilisé. Ce cron est le filet de sécurité
 * qui rattrape les paiements pour lesquels l'utilisateur n'a pas suivi
 * la redirection callback (navigateur fermé, perte de connexion, etc.).
 */

const cron = require('node-cron');
const verificationService = require('../../api/services/user/korapayVerificationService');

const CRON_EXPRESSION = '*/2 * * * *'; // toutes les 2 minutes

let task = null;
let isRunning = false;

function start() {
  if (task) {
    console.log('[KorapayVerificationJob] Déjà démarré');
    return task;
  }

  task = cron.schedule(CRON_EXPRESSION, async () => {
    if (isRunning) {
      console.log('[KorapayVerificationJob] Tick précédent encore en cours, skip');
      return;
    }
    isRunning = true;
    try {
      await verificationService.verifyAllPendingTransactions();
    } catch (error) {
      console.error('[KorapayVerificationJob] Erreur tick:', error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log(`[KorapayVerificationJob] Démarré (cron: ${CRON_EXPRESSION})`);
  return task;
}

function stop() {
  if (!task) return;
  task.stop();
  task = null;
  console.log('[KorapayVerificationJob] Arrêté');
}

module.exports = { start, stop };
