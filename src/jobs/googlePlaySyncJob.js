const cron = require('node-cron');
const GooglePlayTransaction = require('../api/models/user/GooglePlayTransaction');
const Subscription = require('../api/models/common/Subscription');
const googlePlayService = require('../api/services/user/GooglePlayService');

function googleErrorSummary(error) {
  const status = Number(error?.response?.status || error?.status || error?.code);
  return { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null };
}

// Job pour synchroniser les abonnements Google Play actifs
// S'exécute toutes les 6 heures
const syncGooglePlaySubscriptions = cron.schedule('0 */6 * * *', async () => {
  console.log('[CRON] Début de la synchronisation Google Play');
  
  try {
    // Récupérer toutes les transactions Google Play actives
    const activeTransactions = await GooglePlayTransaction.find({
      status: { $in: ['ACTIVE', 'CANCELED'] },
      expiryTime: { $gt: new Date() },
      // Missing type is the historical subscription representation. Explicit
      // one-time purchases must never be sent to subscriptionsv2.get.
      $or: [{ purchaseType: 'SUBSCRIPTION' }, { purchaseType: { $exists: false } }]
    });

    console.log(`[CRON] ${activeTransactions.length} transactions à synchroniser`);

    let successCount = 0;
    let errorCount = 0;

    for (const transaction of activeTransactions) {
      try {
        await googlePlayService.syncSubscription(transaction.purchaseToken);
        successCount++;
      } catch (error) {
        console.error('[CRON] Erreur sync Google Play:', googleErrorSummary(error));
        errorCount++;
      }
    }

    console.log(`[CRON] Synchronisation terminée - Succès: ${successCount}, Erreurs: ${errorCount}`);

  } catch (error) {
    console.error('[CRON] Erreur globale synchronisation Google Play:', googleErrorSummary(error));
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
    console.error('[CRON] Erreur nettoyage abonnements:', googleErrorSummary(error));
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
        // L'API d'acknowledge diffère selon le type d'achat : les produits
        // ponctuels passent par products.acknowledge (+consume), les
        // abonnements par subscriptions.acknowledge. Utiliser la mauvaise
        // API échoue silencieusement → Google rembourse après 3 jours.
        if (transaction.purchaseType === 'ONE_TIME_PRODUCT') {
          await googlePlayService.acknowledgeAndConsumeOneTimePurchase(
            transaction.purchaseToken,
            transaction.productId
          );
        } else {
          await googlePlayService.acknowledgePurchase(transaction.purchaseToken);
        }
        console.log('[CRON] Achat acknowledged');
      } catch (error) {
        console.error('[CRON] Erreur acknowledge Google Play:', googleErrorSummary(error));
      }
    }

  } catch (error) {
    console.error('[CRON] Erreur vérification acknowledgements:', googleErrorSummary(error));
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
