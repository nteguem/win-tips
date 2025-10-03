// controllers/user/cinetpayController.js
const cinetpayService = require('../../services/user/CinetpayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Initier un paiement CinetPay
 */
exports.initiatePayment = catchAsync(async (req, res, next) => {
  const { packageId, phoneNumber } = req.body;

  // Validation
  if (!packageId || !phoneNumber) {
    return next(new AppError(
      'packageId et phoneNumber sont requis',
      400,
      ErrorCodes.VALIDATION_ERROR
    ));
  }

  // Vérifier si l'utilisateur a déjà un abonnement actif pour ce package
  const subscriptionService = require('../../services/user/subscriptionService');
  const activeSubscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
  const hasActivePackage = activeSubscriptions.some(sub => 
    sub.package._id.toString() === packageId
  );

  if (hasActivePackage) {
    return next(new AppError(
      'Vous avez déjà un abonnement actif pour ce package',
      400,
      ErrorCodes.VALIDATION_ERROR
    ));
  }

  // Récupérer automatiquement les données utilisateur
  const customerName = req.user.pseudo || req.user.name || req.user.username || 'Utilisateur';
  const email = req.user.email || '';

  const result = await cinetpayService.initiatePayment(
    req.user._id,
    packageId,
    phoneNumber,
    customerName,
    email
  );

  res.status(201).json({
    success: true,
    message: 'Paiement initié avec succès',
    data: {
      transaction: {
        transactionId: result.transaction.transactionId,
        amount: result.transaction.amount,
        currency: result.transaction.currency,
        status: result.transaction.status,
        phoneNumber: result.transaction.phoneNumber,
        customerName: result.transaction.customerName,
        package: result.transaction.package
      },
      paymentUrl: result.paymentUrl
    }
  });
});

/**
 * Vérifier le statut d'un paiement
 */
exports.checkStatus = catchAsync(async (req, res, next) => {
  const { transactionId } = req.params;

  const transaction = await cinetpayService.checkTransactionStatus(transactionId);

  // Vérifier que la transaction appartient à l'utilisateur
  if (transaction.user._id.toString() !== req.user._id.toString()) {
    return next(new AppError('Transaction non autorisée', 403, ErrorCodes.UNAUTHORIZED));
  }

  // Traiter la transaction si le statut a changé
  let subscription = null;
  try {
    subscription = await paymentMiddleware.processTransactionUpdate(transaction);
  } catch (error) {
    console.error('Error processing transaction update:', error.message);
  }

  res.status(200).json({
    success: true,
    data: {
      transaction: {
        transactionId: transaction.transactionId,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod,
        processed: transaction.processed,
        createdAt: transaction.createdAt,
        package: transaction.package
      },
      subscription: subscription ? {
        id: subscription._id,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        status: subscription.status
      } : null
    }
  });
});

/**
 * Webhook CinetPay
 */
exports.webhook = catchAsync(async (req, res, next) => {
  const receivedToken = req.headers['x-token'];
  const { cpm_trans_id: transactionId, cpm_error_message } = req.body;

  console.log('CinetPay webhook received:', req.body);

  if (!transactionId) {
    return next(new AppError('Transaction ID requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  try {
    // Chercher la transaction
    const CinetpayTransaction = require('../../models/user/CinetpayTransaction');
    const transaction = await CinetpayTransaction.findOne({ transactionId })
      .populate(['package', 'user']);

    if (!transaction) {
      return next(new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND));
    }

    // Vérifier HMAC avec le bon SECRET_KEY selon la devise de la transaction
    // if (receivedToken) {
    //   const isValidToken = cinetpayService.verifyHmacToken(
    //     receivedToken, 
    //     req.body, 
    //     transaction.currency // Passez la devise de la transaction
    //   );
    //   if (!isValidToken) {
    //     console.warn(`CinetPay - Invalid HMAC token for ${transaction.currency} transaction ${transactionId}`);
    //   } else {
    //     console.log(`CinetPay - Valid HMAC token for ${transaction.currency} transaction ${transactionId}`);
    //   }
    // }

    // Mettre à jour la transaction avec les données webhook
    transaction.cpmTransDate = req.body.cpm_trans_date;
    transaction.cpmErrorMessage = cpm_error_message;
    transaction.paymentMethod = req.body.payment_method;
    transaction.cpmPhonePrefix = req.body.cpm_phone_prefixe;
    transaction.cpmLanguage = req.body.cpm_language;
    transaction.cpmVersion = req.body.cpm_version;
    transaction.cmpPaymentConfig = req.body.cpm_payment_config;
    transaction.cmpPageAction = req.body.cpm_page_action;
    transaction.cmpCustom = req.body.cpm_custom;
    transaction.cmpDesignation = req.body.cpm_designation;
    transaction.webhookSignature = req.body.signature;

    // Déterminer le statut
    if (cpm_error_message === 'SUCCES') {
      transaction.status = 'ACCEPTED';
    } else if (cpm_error_message === 'PAYMENT_FAILED') {
      transaction.status = 'REFUSED';
    } else if (cpm_error_message === 'TRANSACTION_CANCEL') {
      transaction.status = 'CANCELED';
    } else {
      transaction.status = 'REFUSED';
    }

    await transaction.save();
    console.log(`Transaction ${transactionId} updated to status: ${transaction.status}`);

    // Traiter la transaction mise à jour (la transaction est déjà populée)
    await paymentMiddleware.processTransactionUpdate(transaction);

    res.status(200).json({
      success: true,
      message: 'Webhook traité avec succès'
    });

  } catch (error) {
    console.error('Webhook processing error:', error.message);
    console.error('Error stack:', error.stack);
    
    // Toujours retourner 200 pour que CinetPay ne renvoie pas le webhook
    res.status(200).json({
      success: false,
      message: 'Erreur lors du traitement du webhook',
      error: error.message
    });
  }
});

/**
 * Page de retour après paiement (return_url) - Version complète comme l'ancien
 */
exports.paymentSuccess = catchAsync(async (req, res, next) => {
  const { token, transaction_id } = req.method === 'GET' ? req.query : req.body;

  if (!transaction_id) {
    const errorContent = `
      <div class="icon">❌</div>
      <h1 class="error">Erreur</h1>
      <p>Paramètres de transaction manquants.</p>
      <p>Veuillez réessayer ou contacter le support.</p>
    `;
    return res.status(400).send(getHtmlTemplate('CinetPay - Erreur', errorContent));
  }

  let transactionStatus;
  let errorOccurred = false;

  try {
    transactionStatus = await cinetpayService.checkTransactionStatus(transaction_id);
    
    // Traiter la transaction
    await paymentMiddleware.processTransactionUpdate(transactionStatus);
  } catch (error) {
    console.error('CinetPay - Erreur lors de la vérification:', error.message);
    errorOccurred = true;
  }

  // Générer le contenu HTML selon le statut
  let content;

  if (errorOccurred) {
    content = `
      <div class="icon">⏳</div>
      <h1 class="warning">Vérification en cours</h1>
      <p>Nous vérifions le statut de votre paiement...</p>
      <p>Vous recevrez une notification dès que le traitement sera terminé.</p>
      <div class="transaction-id">${transaction_id}</div>
    `;
  } else if (transactionStatus.status === 'ACCEPTED') {
    content = `
      <div class="icon">🎉</div>
      <h1 class="success">Paiement Réussi !</h1>
      <div class="status-badge status-success">✅ Confirmé</div>
      <p>Votre abonnement <strong>${transactionStatus.package.name}</strong> a été activé avec succès.</p>
      
      <div class="details">
        <p><strong>Transaction:</strong> <span class="transaction-id">${transaction_id}</span></p>
        <p><strong>Montant:</strong> <span class="amount">${transactionStatus.amount} ${transactionStatus.currency}</span></p>
        <p><strong>Méthode:</strong> ${transactionStatus.paymentMethod || 'CinetPay'}</p>
        <p><strong>Durée:</strong> ${transactionStatus.package.duration} jours</p>
      </div>
      
      <p>✅ Notification de confirmation envoyée</p>
      <p>✅ Accès premium maintenant actif</p>
    `;
  } else if (transactionStatus.status === 'REFUSED' || transactionStatus.status === 'CANCELED') {
    let failureReason = 'Paiement refusé';
    if (transactionStatus.errorCode === '600') {
      failureReason = 'Fonds insuffisants';
    } else if (transactionStatus.errorCode === '627') {
      failureReason = 'Transaction annulée';
    }
    
    content = `
      <div class="icon">❌</div>
      <h1 class="error">Paiement Échoué</h1>
      <div class="status-badge status-error">❌ Refusé</div>
      <p><strong>${failureReason}</strong></p>
      <div class="transaction-id">${transaction_id}</div>
      <p>Veuillez réessayer ou contacter le support.</p>
    `;
  } else if (transactionStatus.status === 'WAITING_FOR_CUSTOMER') {
    content = `
      <div class="icon">📱</div>
      <h1 class="warning">Confirmation Requise</h1>
      <div class="status-badge status-warning">⏳ En attente</div>
      <p>Votre demande de paiement a été envoyée.</p>
      
      <div class="highlight">
        <p><strong>📲 Vérifiez votre téléphone</strong></p>
        <p>Notification envoyée au <strong>${transactionStatus.phoneNumber}</strong></p>
        <p>Composez votre code PIN pour confirmer.</p>
      </div>
      
      <p>Vous recevrez une notification de confirmation.</p>
    `;
  } else {
    content = `
      <div class="icon">⏳</div>
      <h1 class="pending">Paiement En Attente</h1>
      <div class="status-badge status-pending">⏳ En cours</div>
      <p>Votre paiement est en cours de traitement.</p>
      <div class="transaction-id">${transaction_id}</div>
      <p>Veuillez patienter quelques instants.</p>
    `;
  }

  return res.send(getHtmlTemplate(`CinetPay - ${transactionStatus?.status || 'Statut'}`, content));
});

// CSS et HTML template helpers (même que votre ancien)
const getMobileOptimizedCSS = () => `
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      line-height: 1.6;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      width: 100%;
      max-width: 400px;
      padding: 24px;
      text-align: center;
      animation: slideUp 0.3s ease-out;
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 { font-size: 1.5rem; margin-bottom: 16px; font-weight: 600; }
    p { font-size: 0.95rem; color: #666; margin-bottom: 12px; }
    .success { color: #10b981; }
    .error { color: #ef4444; }
    .warning { color: #f59e0b; }
    .pending { color: #6366f1; }
    .details {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px;
      margin: 20px 0;
      text-align: left;
    }
    .details p { margin-bottom: 8px; font-size: 0.9rem; color: #374151; }
    .details p:last-child { margin-bottom: 0; }
    .highlight {
      background: #fef3c7;
      border: 1px solid #fbbf24;
      border-radius: 12px;
      padding: 16px;
      margin: 20px 0;
      border-left: 4px solid #f59e0b;
    }
    .highlight p { color: #92400e; font-size: 0.9rem; }
    .icon { font-size: 2rem; margin-bottom: 12px; }
    .transaction-id {
      font-family: 'Courier New', monospace;
      background: #f1f5f9;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.85rem;
      color: #475569;
      display: inline-block;
      margin: 8px 0;
    }
    .amount { font-size: 1.1rem; font-weight: 600; color: #1f2937; }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 500;
      margin: 8px 0;
    }
    .status-success { background: #d1fae5; color: #065f46; }
    .status-error { background: #fee2e2; color: #991b1b; }
    .status-warning { background: #fef3c7; color: #92400e; }
    .status-pending { background: #e0e7ff; color: #3730a3; }
    @media (max-width: 480px) {
      .container { padding: 20px; margin: 12px; border-radius: 12px; }
      h1 { font-size: 1.3rem; }
      p { font-size: 0.9rem; }
      .details, .highlight { padding: 14px; }
    }
  </style>
`;

const getHtmlTemplate = (title, content) => `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#667eea">
    <title>${title}</title>
    ${getMobileOptimizedCSS()}
  </head>
  <body>
    <div class="container">
      ${content}
    </div>
  </body>
  </html>
`;

module.exports = {
  initiatePayment: exports.initiatePayment,
  checkStatus: exports.checkStatus,
  webhook: exports.webhook,
  paymentSuccess: exports.paymentSuccess
};