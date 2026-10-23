const subscriptionService = require('../../services/user/subscriptionService');
const notificationService = require('../../services/common/notificationService');
const Device = require('../../models/common/Device');

/**
 * Bibliothèque de messages pour notifications de paiement réussi (10 variétés)
 */
const SUCCESS_NOTIFICATIONS = [
  {
    headings: {
      en: "🎉 Welcome Premium!",
      fr: "🎉 Bienvenue Premium!"
    },
    contents: {
      en: "⭐ Your subscription is active: {package}",
      fr: "⭐ Ton abonnement est actif: {package}"
    }
  },
  {
    headings: {
      en: "✅ Payment Success!",
      fr: "✅ Paiement Réussi!"
    },
    contents: {
      en: "🔥 Premium unlocked: {package}",
      fr: "🔥 Premium débloqué: {package}"
    }
  },
  {
    headings: {
      en: "🎊 You're Premium!",
      fr: "🎊 Tu es Premium!"
    },
    contents: {
      en: "💎 Enjoy all features: {package}",
      fr: "💎 Profite de tout: {package}"
    }
  },
  {
    headings: {
      en: "🌟 Subscription Active!",
      fr: "🌟 Abonnement Actif!"
    },
    contents: {
      en: "🎯 Full access now: {package}",
      fr: "🎯 Accès complet: {package}"
    }
  },
  {
    headings: {
      en: "💰 Payment Confirmed!",
      fr: "💰 Paiement Confirmé!"
    },
    contents: {
      en: "⚡ Premium ready: {package}",
      fr: "⚡ Premium activé: {package}"
    }
  },
  {
    headings: {
      en: "🎁 Premium Unlocked!",
      fr: "🎁 Premium Débloqué!"
    },
    contents: {
      en: "🔔 All set with: {package}",
      fr: "🔔 C'est parti avec: {package}"
    }
  },
  {
    headings: {
      en: "✨ Success!",
      fr: "✨ Succès!"
    },
    contents: {
      en: "🎲 Premium activated: {package}",
      fr: "🎲 Premium activé: {package}"
    }
  },
  {
    headings: {
      en: "🚀 All Access!",
      fr: "🚀 Accès Total!"
    },
    contents: {
      en: "💎 Premium live: {package}",
      fr: "💎 Premium en ligne: {package}"
    }
  },
  {
    headings: {
      en: "🔥 You're In!",
      fr: "🔥 C'est Bon!"
    },
    contents: {
      en: "⭐ Subscription ready: {package}",
      fr: "⭐ Abonnement prêt: {package}"
    }
  },
  {
    headings: {
      en: "💪 Premium Active!",
      fr: "💪 Premium Actif!"
    },
    contents: {
      en: "🎯 Enjoy: {package}",
      fr: "🎯 Profite de: {package}"
    }
  }
];

/**
 * Bibliothèque de messages pour notifications de paiement échoué (10 variétés)
 */
const FAILED_NOTIFICATIONS = [
  {
    headings: {
      en: "❌ Payment Issue",
      fr: "❌ Problème Paiement"
    },
    contents: {
      en: "⚠️ Payment failed for: {package}",
      fr: "⚠️ Paiement échoué pour: {package}"
    }
  },
  {
    headings: {
      en: "🔴 Transaction Error",
      fr: "🔴 Erreur Transaction"
    },
    contents: {
      en: "💳 Please retry: {package}",
      fr: "💳 Réessaye: {package}"
    }
  },
  {
    headings: {
      en: "⚠️ Payment Failed",
      fr: "⚠️ Paiement Échoué"
    },
    contents: {
      en: "🔄 Try again: {package}",
      fr: "🔄 Réessaie: {package}"
    }
  },
  {
    headings: {
      en: "❗ Issue Detected",
      fr: "❗ Problème Détecté"
    },
    contents: {
      en: "💔 Payment unsuccessful: {package}",
      fr: "💔 Paiement non abouti: {package}"
    }
  },
  {
    headings: {
      en: "🚫 Payment Declined",
      fr: "🚫 Paiement Refusé"
    },
    contents: {
      en: "🔧 Check your payment: {package}",
      fr: "🔧 Vérifie ton paiement: {package}"
    }
  },
  {
    headings: {
      en: "⛔ Transaction Failed",
      fr: "⛔ Transaction Échouée"
    },
    contents: {
      en: "💡 Need help with: {package}",
      fr: "💡 Besoin d'aide pour: {package}"
    }
  },
  {
    headings: {
      en: "❌ Processing Error",
      fr: "❌ Erreur Traitement"
    },
    contents: {
      en: "📞 Contact support: {package}",
      fr: "📞 Contacte le support: {package}"
    }
  },
  {
    headings: {
      en: "🔴 Payment Problem",
      fr: "🔴 Problème de Paiement"
    },
    contents: {
      en: "🔄 Retry payment: {package}",
      fr: "🔄 Relance le paiement: {package}"
    }
  },
  {
    headings: {
      en: "⚠️ Action Needed",
      fr: "⚠️ Action Requise"
    },
    contents: {
      en: "💳 Payment issue: {package}",
      fr: "💳 Souci paiement: {package}"
    }
  },
  {
    headings: {
      en: "❗ Payment Not Completed",
      fr: "❗ Paiement Non Finalisé"
    },
    contents: {
      en: "🔧 Try once more: {package}",
      fr: "🔧 Retente: {package}"
    }
  }
];

/**
 * Fonction pour sélectionner un message aléatoire
 */
function getRandomNotification(notificationArray, packageName) {
  const randomIndex = Math.floor(Math.random() * notificationArray.length);
  const template = notificationArray[randomIndex];
  
  return {
    headings: template.headings,
    contents: {
      en: template.contents.en.replace('{package}', packageName),
      fr: template.contents.fr.replace('{package}', packageName)
    }
  };
}

/**
 * Envoyer notification de paiement réussi
 */
async function sendPaymentSuccessNotification(transaction) {
  try {
    // Récupérer le device de l'utilisateur pour avoir son playerId
    const device = await Device.findOne({
      user: transaction.user,
      isActive: true,
      playerId: { $exists: true, $ne: null }
    }).sort({ lastActiveAt: -1 });
    
    if (!device || !device.playerId) {
      console.log(`No playerId found for user ${transaction.user}, skipping notification`);
      return;
    }
    
    // Populer le package pour avoir son nom
    await transaction.populate('package');
    const packageName = transaction.package?.name?.fr || transaction.package?.name?.en || 'Package Premium';
    
    // Sélection aléatoire du message
    const randomMessage = getRandomNotification(SUCCESS_NOTIFICATIONS, packageName);
    
    const notification = {
      headings: randomMessage.headings,
      contents: randomMessage.contents,
      data: {
        type: "payment_success",
        transaction_id: transaction._id.toString(),
        package_id: transaction.package._id.toString(),
        subscription_type: "premium",
        action: "view_subscription"
      },
      options: {
        android_accent_color: "00C853", // Vert pour succès
        small_icon: "ic_notification",
        large_icon: "ic_launcher",
        priority: 8
      }
    };
    
    await notificationService.sendToUsers([device.playerId], notification);
    
    console.log(`✅ Payment success notification sent to user ${transaction.user}`);
  } catch (error) {
    console.error(`❌ Error sending payment success notification:`, error.message);
  }
}

/**
 * Envoyer notification de paiement échoué
 */
async function sendPaymentFailedNotification(transaction) {
  try {
    // Récupérer le device de l'utilisateur
    const device = await Device.findOne({
      user: transaction.user,
      isActive: true,
      playerId: { $exists: true, $ne: null }
    }).sort({ lastActiveAt: -1 });
    
    if (!device || !device.playerId) {
      console.log(`No playerId found for user ${transaction.user}, skipping notification`);
      return;
    }
    
    // Populer le package
    await transaction.populate('package');
    const packageName = transaction.package?.name?.fr || transaction.package?.name?.en || 'Package Premium';
    
    // Sélection aléatoire du message
    const randomMessage = getRandomNotification(FAILED_NOTIFICATIONS, packageName);
    
    const notification = {
      headings: randomMessage.headings,
      contents: randomMessage.contents,
      data: {
        type: "payment_failed",
        transaction_id: transaction._id.toString(),
        package_id: transaction.package._id.toString(),
        action: "retry_payment"
      },
      options: {
        android_accent_color: "D32F2F", // Rouge pour échec
        small_icon: "ic_notification",
        large_icon: "ic_launcher",
        priority: 7
      }
    };
    
    await notificationService.sendToUsers([device.playerId], notification);
    
    console.log(`⚠️ Payment failed notification sent to user ${transaction.user}`);
  } catch (error) {
    console.error(`❌ Error sending payment failed notification:`, error.message);
  }
}

/**
 * Traiter une transaction réussie
 */
async function handleSuccessfulTransaction(transaction) {
  try {
    if (transaction.isSuccessful() && !transaction.processed) {
      console.log(`Processing successful transaction: ${transaction._id}`);
      
      // Créer la souscription 
      const subscription = await subscriptionService.createSubscription(
        transaction.user,
        transaction.package,
        transaction.currency,
        transaction._id
      );
      
      console.log(`Subscription created: ${subscription._id}`);
      
      // Marquer comme traité
      transaction.processed = true;
      await transaction.save();
      
      console.log(`Transaction ${transaction._id} marked as processed`);
      
      // 🎯 Envoyer notification de succès
      await sendPaymentSuccessNotification(transaction);
      
      return subscription;
    }
    
    return null;
  } catch (error) {
    console.error(`Error processing transaction ${transaction._id}:`, error.message);
    throw error;
  }
}

/**
 * Traiter une transaction échouée
 */
async function handleFailedTransaction(transaction) {
  try {
    console.log(`Processing failed transaction: ${transaction._id}`);
    
    // 🎯 Envoyer notification d'échec
    await sendPaymentFailedNotification(transaction);
    
    // Marquer comme traité même en cas d'échec
    transaction.processed = true;
    await transaction.save();
    
    console.log(`Failed transaction ${transaction._id} marked as processed`);
  } catch (error) {
    console.error(`Error processing failed transaction ${transaction._id}:`, error.message);
  }
}

/**
 * Traiter une transaction mise à jour
 */
async function processTransactionUpdate(transaction) {
  try {
    // Traiter selon le statut
    if (transaction.isSuccessful()) {
      return await handleSuccessfulTransaction(transaction);
    } 
    else if (transaction.status === 'FAILED' || transaction.status === 'REFUSED' || transaction.status === 'ERROR' || transaction.status === 'CANCELED' || transaction.status === 'CANCELLED' || transaction.status === 'EXPIRED') {
      await handleFailedTransaction(transaction);
    }
    
    return null;
  } catch (error) {
    console.error(`Error in transaction middleware:`, error.message);
    throw error;
  }
}

module.exports = {
  processTransactionUpdate,
  handleSuccessfulTransaction,
  handleFailedTransaction,
  sendPaymentSuccessNotification,
  sendPaymentFailedNotification
};