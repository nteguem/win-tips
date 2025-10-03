const subscriptionService = require('../../services/user/subscriptionService');


async function handleSuccessfulTransaction(transaction) {
  try {
    if (transaction.isSuccessful() && !transaction.processed) {
      console.log(`Processing successful transaction: ${transaction._id}`);
      
      // Créer la souscription 
      const subscription = await subscriptionService.createSubscription(
        transaction.user,
        transaction.package,
        transaction.currency ,
        transaction._id
      );
      
      console.log(`Subscription created: ${subscription._id}`);
      
      // Marquer comme traité
      transaction.processed = true;
      await transaction.save();
      
      console.log(`Transaction ${transaction._id} marked as processed`);
      
      return subscription;
    }
    
    return null;
  } catch (error) {
    console.error(`Error processing transaction ${transaction._id}:`, error.message);
    throw error;
  }
}

/**
 * Middleware pour traiter les transactions échouées
 */
async function handleFailedTransaction(transaction) {
  try {
      console.log(`Processing failed transaction: ${transaction._id}`);
      
      // TODO: Envoyer notification d'échec
      // await notificationService.sendPaymentFailed(transaction);
      
      // Marquer comme traité même en cas d'échec
      transaction.processed = true;
      await transaction.save();
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
    else {
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
  handleFailedTransaction
};