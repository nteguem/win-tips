const service = require('../../services/user/CinetpayService');
const Transaction = require('../../models/user/CinetpayTransaction');
const subscriptionService = require('../../services/user/subscriptionService');
const safety = require('../../services/user/paymentTransactionSafety');
const controller = require('./paymentTransactionController');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

exports.initiatePayment = catchAsync(async (req, res) => {
  const { packageId, phoneNumber, currency, clientReference, restartTransactionId } = req.body;
  if (typeof packageId !== 'string' || !/^[a-f0-9]{24}$/i.test(packageId)) {
    throw new AppError('packageId est requis', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const reference = safety.validateClientReference(clientReference);
  if (restartTransactionId) {
    if (!reference) throw new AppError('Référence de tentative requise', 400, ErrorCodes.VALIDATION_ERROR);
    const previous = await controller.owned(Transaction, 'transactionId', restartTransactionId, req.user._id);
    if (String(previous.package?._id || previous.package) !== packageId || previous.clientReference === reference) {
      throw new AppError('Nouvelle tentative de paiement invalide', 409, ErrorCodes.VALIDATION_ERROR);
    }
    // Verify again at the user's click, before creating any replacement page.
    // A payment confirmed in the meantime delivers its original access.
    let checked;
    try { checked = await service.checkTransactionStatus(restartTransactionId); } catch (_) {
      throw new AppError('Vérification temporairement indisponible. Réessayez dans un instant.', 503, ErrorCodes.SERVICE_UNAVAILABLE);
    }
    if (checked.status === 'ACCEPTED') {
      const activated = await controller.activate(Transaction, checked);
      return res.status(200).json({ success: true, data: controller.responseData(activated.transaction, activated.subscription) });
    }
    if (!checked.canStartNewCheckout) throw new AppError('Vérifiez le paiement précédent avant de réessayer', 409, ErrorCodes.VALIDATION_ERROR);
  }
  const retry = reference && await Transaction.findOne({ user: req.user._id, clientReference: reference });
  if (!retry) {
    const subscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
    if (subscriptions.some(sub => String(sub.package?._id || sub.package) === packageId)) throw new AppError('Vous avez déjà un accès actif pour ce package', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const result = await service.initiatePayment(req.user._id, packageId, phoneNumber,
    req.user.pseudo || req.user.name || req.user.username || 'Utilisateur', req.user.email || '', currency, reference);
  if (restartTransactionId) await Transaction.updateOne({ _id: result.transaction._id }, { $set: { replacesTransactionId: restartTransactionId } });
  return controller.initiationResponse(res, result);
});

exports.checkStatus = catchAsync(async (req, res) => {
  const result = await controller.verify(Transaction, 'transactionId', service, req.params.transactionId, req.user._id);
  res.status(200).json({ success: true, data: controller.responseData(result.transaction, result.subscription) });
});

exports.pending = catchAsync(async (req, res) => controller.pending(Transaction, req, res));

exports.notify = catchAsync(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const transactionId = params.merchant_transaction_id || params.cpm_trans_id || params.transaction_id;
  if (typeof transactionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(transactionId)) {
    return res.status(400).json({ success: false, message: 'Référence de transaction invalide' });
  }
  const { statusCode, ...body } = await controller.queueWebhook(Transaction, 'transactionId', transactionId, service, params.notify_token);
  return res.status(statusCode).json(body);
});

// This browser return is presentation only, never proof of settlement. Durable
// webhook processing, the worker and authenticated status verify payment.
exports.paymentReturn = catchAsync(async (req, res) => {
  const params = { ...req.query, ...req.body };
  const transactionId = params.merchant_transaction_id || params.transaction_id || params.cpm_trans_id || params.transactionId;
  const validId = typeof transactionId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(transactionId);
  const transaction = validId ? await Transaction.findOne({ transactionId }) : null;
  let content;
  if (transaction?.status === 'ACCEPTED' && transaction.processed && transaction.subscriptionId) {
    content = '<div class="icon">✓</div><h1 class="success">Paiement confirmé</h1><p>Votre accès est activé. Retournez dans l’application.</p>';
  } else if (transaction && ['REFUSED', 'CANCELED'].includes(transaction.status)) {
    content = '<h1 class="error">Paiement non confirmé</h1><p>Retournez dans l’application pour vérifier ou réessayer.</p>';
  } else {
    content = '<h1 class="pending">Vérification du paiement</h1><p>Retournez dans l’application et appuyez sur Vérifier. Ne relancez pas un paiement déjà débité.</p>';
  }
  if (validId) content += `<div class="transaction-id">${escapeHtml(transactionId)}</div>`;
  return res.send(htmlTemplate('CinetPay', content));
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

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
