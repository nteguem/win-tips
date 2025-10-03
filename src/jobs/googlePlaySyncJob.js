const cron = require('node-cron');
const GooglePlayTransaction = require('../api/models/user/GooglePlayTransaction');
const Subscription = require('../api/models/common/Subscription');
const googlePlayService = require('../api/services/user/GooglePlayService');

// Job pour synchroniser les abonnements Google Play actifs
// S'exécute toutes les 6 heures
const syncGooglePlaySubscriptions = cron.schedule('0 */6 * * *', async () => {
  console.log('[CRON] Début de la synchronisation Google Play');
  
  try {
    // Récupérer toutes les transactions Google Play actives
    const activeTransactions = await GooglePlayTransaction.find({
      status: { $in: ['ACTIVE', 'CANCELED'] },
      expiryTime: { $gt: new Date() }
    });

    console.log(`[CRON] ${activeTransactions.length} transactions à synchroniser`);

    let successCount = 0;
    let errorCount = 0;

    for (const transaction of activeTransactions) {
      try {
        await googlePlayService.syncSubscription(transaction.purchaseToken);
        successCount++;
      } catch (error) {
        console.error(`[CRON] Erreur sync ${transaction.purchaseToken}:`, error.message);
        errorCount++;
      }
    }

    console.log(`[CRON] Synchronisation terminée - Succès: ${successCount}, Erreurs: ${errorCount}`);

  } catch (error) {
    console.error('[CRON] Erreur globale synchronisation Google Play:', error);
  }
}, {
  scheduled: false // Ne pas démarrer automatiquement
});

// Job pour nettoyer les abonnements expirés
// S'exécute tous les jours à 2h du matin
const cleanupExpiredSubscriptions = cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Début du nettoyage des abonnements expirés');
  
  try {
    // 1. Nettoyer les abonnements Mobile Money expirés
    const expiredMobileMoney = await Subscription.updateMany(
      {
        paymentProvider: 'MOBILE_MONEY',
        status: 'active',
        endDate: { $lt: new Date() }
      },
      {
        $set: { status: 'expired' }
      }
    );

    console.log(`[CRON] ${expiredMobileMoney.modifiedCount} abonnements Mobile Money expirés`);

    // 2. Nettoyer les transactions Google Play expirées
    const expiredGooglePlay = await GooglePlayTransaction.find({
      status: { $in: ['ACTIVE', 'CANCELED'] },
      expiryTime: { $lt: new Date() },
      autoRenewing: false
    });

    for (const transaction of expiredGooglePlay) {
      transaction.status = 'EXPIRED';
      await transaction.save();

      // Mettre à jour la subscription associée
      await Subscription.findByIdAndUpdate(
        transaction.subscription,
        { status: 'expired' }
      );
    }

    console.log(`[CRON] ${expiredGooglePlay.length} transactions Google Play expirées`);

  } catch (error) {
    console.error('[CRON] Erreur nettoyage abonnements:', error);
  }
}, {
  scheduled: false
});

// Job pour vérifier les achats non-acknowledged
// S'exécute toutes les heures
const checkUnacknowledgedPurchases = cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Vérification des achats non-acknowledged');
  
  try {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 2.5); // 2.5 jours pour avoir de la marge

    const unacknowledged = await GooglePlayTransaction.find({
      acknowledged: false,
      purchaseTime: { $lt: threeDaysAgo },
      status: { $ne: 'EXPIRED' }
    });

    console.log(`[CRON] ${unacknowledged.length} achats à acknowledger d'urgence`);

    for (const transaction of unacknowledged) {
      try {
        await googlePlayService.acknowledgePurchase(transaction.purchaseToken);
        console.log(`[CRON] Acknowledged: ${transaction.purchaseToken}`);
      } catch (error) {
        console.error(`[CRON] Erreur acknowledge ${transaction.purchaseToken}:`, error.message);
      }
    }

  } catch (error) {
    console.error('[CRON] Erreur vérification acknowledgements:', error);
  }
}, {
  scheduled: false
});

// Fonctions pour démarrer/arrêter les jobs
module.exports = {
  start: () => {
    console.log('[CRON] Démarrage des jobs Google Play');
    syncGooglePlaySubscriptions.start();
    cleanupExpiredSubscriptions.start();
    checkUnacknowledgedPurchases.start();
  },
  
  stop: () => {
    console.log('[CRON] Arrêt des jobs Google Play');
    syncGooglePlaySubscriptions.stop();
    cleanupExpiredSubscriptions.stop();
    checkUnacknowledgedPurchases.stop();
  },
  
  // Pour exécuter manuellement
  syncNow: async () => {
    console.log('[CRON] Synchronisation manuelle déclenchée');
    await syncGooglePlaySubscriptions._callbacks[0]();
  },
  
  cleanupNow: async () => {
    console.log('[CRON] Nettoyage manuel déclenché');
    await cleanupExpiredSubscriptions._callbacks[0]();
  }
};