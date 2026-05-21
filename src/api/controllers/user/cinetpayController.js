// controllers/user/cinetpayController.js
//
// Controller CinetPay — nouvelle API (api.cinetpay.co/v1). Mono-tenant.
// Routes :
//   POST /payments/cinetpay/initiate         (auth)
//   GET  /payments/cinetpay/status/:id       (auth)
//   POST /payments/cinetpay/notify           (public — webhook serveur→serveur)
//   GET/POST /payments/cinetpay/return       (public — page retour navigateur)

const cinetpayService = require('../../services/user/CinetpayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');
const subscriptionService = require('../../services/user/subscriptionService');
const CinetpayTransaction = require('../../models/user/CinetpayTransaction');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');
const logger = require('../../../utils/logger');

/**
 * Initier un paiement CinetPay.
 * phoneNumber et currency sont optionnels : le client saisit son n° sur
 * la page hostée CinetPay, et currency tombe sur un fallback si absent.
 */
exports.initiatePayment = catchAsync(async (req, res, next) => {
  const { packageId, phoneNumber, currency } = req.body;

  if (!packageId) {
    return next(new AppError('packageId est requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const activeSubscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
  const hasActivePackage = activeSubscriptions.some(sub =>
    sub.package && sub.package._id.toString() === packageId
  );
  if (hasActivePackage) {
    return next(new AppError('Vous avez déjà un abonnement actif pour ce package', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const customerName = req.user.pseudo || req.user.name || req.user.username || 'Utilisateur';
  const email = req.user.email || '';

  const result = await cinetpayService.initiatePayment(
    req.user._id,
    packageId,
    phoneNumber,
    customerName,
    email,
    currency
  );

  res.status(201).json({
    success: true,
    message: 'Paiement initié avec succès',
    data: {
      transaction: {
        transactionId: result.transaction.transactionId,
        cinetpayTransactionId: result.transaction.cinetpayTransactionId,
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
 * Vérifier le statut d'un paiement.
 */
exports.checkStatus = catchAsync(async (req, res, next) => {
  const { transactionId } = req.params;

  const transaction = await cinetpayService.checkTransactionStatus(transactionId);

  if (transaction.user._id.toString() !== req.user._id.toString()) {
    return next(new AppError('Transaction non autorisée', 403, ErrorCodes.UNAUTHORIZED));
  }

  let subscription = null;
  try {
    subscription = await paymentMiddleware.processTransactionUpdate(transaction);
  } catch (error) {
    logger.error(`[cinetpay] checkStatus: processTransactionUpdate failed — ${error.message}`);
  }

  res.status(200).json({
    success: true,
    data: {
      transaction: {
        transactionId: transaction.transactionId,
        cinetpayTransactionId: transaction.cinetpayTransactionId,
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
 * Webhook CinetPay (notify_url).
 * On ne fait jamais confiance au body brut — on re-fetch le statut via
 * l'API authentifiée. Le body sert juste à identifier la transaction.
 */
exports.notify = catchAsync(async (req, res) => {
  const merchantTransactionId =
    req.body?.merchant_transaction_id ||
    req.body?.transaction_id ||
    req.query?.merchant_transaction_id;

  const notifyToken = req.body?.notify_token || req.query?.notify_token;

  logger.info(`[cinetpay] notify: received ${merchantTransactionId} hasToken=${!!notifyToken}`);

  if (!merchantTransactionId) {
    return res.status(200).json({ success: false, message: 'merchant_transaction_id manquant' });
  }

  try {
    const transaction = await CinetpayTransaction.findOne({ transactionId: merchantTransactionId });
    if (!transaction) {
      logger.warn(`[cinetpay] notify: transaction introuvable ${merchantTransactionId}`);
      // 200 sinon CinetPay retentera indéfiniment.
      return res.status(200).json({ success: false, message: 'Transaction not found' });
    }

    if (notifyToken && transaction.notifyToken && notifyToken !== transaction.notifyToken) {
      logger.warn(`[cinetpay] notify: notify_token mismatch ${merchantTransactionId}`);
      return res.status(200).json({ success: false, message: 'Invalid notify_token' });
    }

    const updated = await cinetpayService.checkTransactionStatus(merchantTransactionId);
    await paymentMiddleware.processTransactionUpdate(updated);

    logger.info(`[cinetpay] notify: processed ${merchantTransactionId} status=${updated.status}`);
    return res.status(200).json({ success: true, message: 'Webhook traité', status: updated.status });
  } catch (error) {
    logger.error(`[cinetpay] notify: processing failed ${merchantTransactionId} — ${error.message}`);
    return res.status(200).json({ success: false, message: error.message });
  }
});

/**
 * Page de retour (success_url / failed_url) — affichée dans le navigateur.
 */
exports.paymentReturn = catchAsync(async (req, res) => {
  const params = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
  const merchantTransactionId =
    params.merchant_transaction_id || params.transaction_id || params.transactionId;
  const queryStatus = params.status;

  if (!merchantTransactionId) {
    const content = queryStatus === 'failed'
      ? `<div class="icon">❌</div><h1 class="error">Paiement annulé</h1><p>Retournez à l'application pour réessayer.</p>`
      : `<div class="icon">✅</div><h1 class="success">Paiement reçu</h1><p>Retournez à l'application pour finaliser.</p>`;
    return res.send(htmlTemplate('CinetPay', content));
  }

  const transaction = await CinetpayTransaction.findOne({ transactionId: merchantTransactionId });
  if (!transaction) {
    return res.status(404).send(htmlTemplate('CinetPay', `
      <div class="icon">❌</div>
      <h1 class="error">Transaction non trouvée</h1>
      <div class="transaction-id">${merchantTransactionId}</div>
    `));
  }

  let status = transaction.status;
  try {
    const updated = await cinetpayService.checkTransactionStatus(merchantTransactionId);
    await paymentMiddleware.processTransactionUpdate(updated);
    status = updated.status;
  } catch (err) {
    logger.warn(`[cinetpay] return: status check failed ${merchantTransactionId} — ${err.message}`);
  }

  let content;
  if (status === 'ACCEPTED') {
    content = `
      <div class="icon">🎉</div>
      <h1 class="success">Paiement Réussi !</h1>
      <div class="status-badge status-success">✅ Confirmé</div>
      <p>Votre abonnement a été activé.</p>
      <div class="transaction-id">${merchantTransactionId}</div>
    `;
  } else if (status === 'REFUSED' || status === 'CANCELED') {
    content = `
      <div class="icon">❌</div>
      <h1 class="error">Paiement Échoué</h1>
      <div class="status-badge status-error">${status === 'CANCELED' ? '🚫 Annulé' : '❌ Refusé'}</div>
      <div class="transaction-id">${merchantTransactionId}</div>
      <p>Veuillez réessayer ou contacter le support.</p>
    `;
  } else {
    content = `
      <div class="icon">⏳</div>
      <h1 class="pending">Paiement en cours</h1>
      <div class="status-badge status-pending">⏳ En attente</div>
      <p>Votre paiement est en cours de traitement.</p>
      <div class="transaction-id">${merchantTransactionId}</div>
    `;
  }

  return res.send(htmlTemplate(`CinetPay - ${status}`, content));
});

function htmlTemplate(title, content) {
  return `<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
.container { background:white; border-radius:16px; box-shadow:0 8px 32px rgba(0,0,0,0.15); width:100%; max-width:400px; padding:24px; text-align:center; }
h1 { font-size:1.5rem; margin:12px 0; font-weight:600; }
p { color:#666; margin:12px 0; }
.success { color:#10b981; } .error { color:#ef4444; } .pending { color:#6366f1; }
.icon { font-size:2rem; }
.transaction-id { font-family:'Courier New',monospace; background:#f1f5f9; padding:6px 12px; border-radius:6px; font-size:0.85rem; color:#475569; display:inline-block; margin:8px 0; }
.status-badge { display:inline-block; padding:4px 12px; border-radius:20px; font-size:0.8rem; font-weight:500; margin:8px 0; }
.status-success { background:#d1fae5; color:#065f46; }
.status-error { background:#fee2e2; color:#991b1b; }
.status-pending { background:#e0e7ff; color:#3730a3; }
</style></head><body><div class="container">${content}</div></body></html>`;
}

module.exports = {
  initiatePayment: exports.initiatePayment,
  checkStatus: exports.checkStatus,
  notify: exports.notify,
  paymentReturn: exports.paymentReturn
};
