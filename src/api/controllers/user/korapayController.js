/**
 * KoraPay Controller (single-tenant).
 *
 * Endpoints :
 *  - POST /api/payments/korapay/initiate    (auth)  → renvoie checkoutUrl
 *  - GET  /api/payments/korapay/status/:ref (auth)  → vérifie + crée souscription si SUCCESS
 *  - POST /api/payments/korapay/webhook     (public) → callback signé KoraPay
 *  - GET  /api/payments/korapay/callback    (public) → page HTML retour utilisateur
 */

const korapayService = require('../../services/user/KorapayService');
const KorapayTransaction = require('../../models/user/KorapayTransaction');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');
const subscriptionService = require('../../services/user/subscriptionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * POST /api/payments/korapay/initiate
 */
exports.initiatePayment = catchAsync(async (req, res, next) => {
  const { packageId, currency, phoneNumber, merchantBearsCost } = req.body;

  if (!packageId || !currency) {
    return next(new AppError('packageId et currency sont requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Empêcher la double-souscription pour le même package
  const activeSubscriptions = await subscriptionService.getActiveSubscriptions(req.user._id);
  const hasActivePackage = activeSubscriptions.some(
    sub => sub.package && sub.package._id.toString() === packageId
  );
  if (hasActivePackage) {
    return next(new AppError(
      'Vous avez déjà un abonnement actif pour ce package',
      400,
      ErrorCodes.VALIDATION_ERROR
    ));
  }

  const customerName = req.user.pseudo || req.user.firstName || req.user.lastName || 'Utilisateur';
  const customerEmail = req.user.email || `user_${req.user._id}@wintips.com`;
  const customerPhone = phoneNumber || req.user.phoneNumber || null;

  try {
    const result = await korapayService.initiatePayment(
      req.user._id,
      packageId,
      currency,
      customerName,
      customerEmail,
      customerPhone,
      !!merchantBearsCost
    );

    return res.status(201).json({
      success: true,
      message: 'Paiement initié avec succès',
      data: {
        transaction: {
          transactionId: result.transaction.transactionId,
          reference: result.transaction.reference,
          amount: result.transaction.amount,
          currency: result.transaction.currency,
          status: result.transaction.status,
          package: result.transaction.package
        },
        checkoutUrl: result.checkoutUrl
      }
    });
  } catch (error) {
    if (error.name === 'KorapayError') {
      return next(new AppError(error.message, error.statusCode || 500, ErrorCodes.INTERNAL_ERROR));
    }
    return next(error);
  }
});

/**
 * GET /api/payments/korapay/status/:reference
 */
exports.checkStatus = catchAsync(async (req, res, next) => {
  const { reference } = req.params;

  const transaction = await korapayService.checkTransactionStatus(reference);

  if (transaction.user._id.toString() !== req.user._id.toString()) {
    return next(new AppError('Transaction non autorisée', 403, ErrorCodes.UNAUTHORIZED));
  }

  let subscription = null;
  try {
    subscription = await paymentMiddleware.processTransactionUpdate(transaction);
  } catch (error) {
    console.error('[KoraPay] Erreur processTransactionUpdate:', error.message);
  }

  return res.status(200).json({
    success: true,
    data: {
      transaction: {
        transactionId: transaction.transactionId,
        reference: transaction.reference,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod,
        processed: transaction.processed,
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
 * GET /api/payments/korapay/callback
 * Public — page de retour HTML après paiement.
 * C'est ici que la souscription est déclenchée (le webhook n'est pas utilisé).
 * Filets de sécurité si l'utilisateur ne suit pas la redirection :
 *  - cron de vérification (toutes les 2 min)
 *  - extension de /me (déclenche une vérif live à chaque ouverture d'app)
 */
exports.callback = async (req, res) => {
  try {
    const { reference } = req.query;
    if (!reference) {
      return res.status(400).send(renderHTML('ERROR', 'Missing reference'));
    }

    const transaction = await KorapayTransaction.findByReference(reference);
    if (!transaction) {
      return res.status(404).send(renderHTML('ERROR', 'Transaction not found'));
    }

    const updated = await korapayService.checkTransactionStatus(reference);
    if (updated.isSuccessful() && !updated.processed) {
      await paymentMiddleware.processTransactionUpdate(updated);
    }

    return res.send(renderHTML(updated.status, updated));
  } catch (error) {
    console.error('[KoraPay-Callback] Erreur:', error.message);
    return res.status(500).send(renderHTML('ERROR', 'Server error'));
  }
};

function renderHTML(status, transaction) {
  const statusConfig = {
    SUCCESS: { icon: '✓', color: '#10b981', title: 'Payment Successful', message: 'Your payment has been confirmed. Your subscription is now active.' },
    PROCESSING: { icon: '⏳', color: '#f59e0b', title: 'Payment Processing', message: 'Your payment is being processed.' },
    FAILED: { icon: '✗', color: '#ef4444', title: 'Payment Failed', message: 'The payment failed. Please try again.' },
    CANCELLED: { icon: '⊗', color: '#6b7280', title: 'Payment Cancelled', message: 'The payment was cancelled.' },
    PENDING: { icon: '⋯', color: '#3b82f6', title: 'Payment Pending', message: 'Your payment is pending confirmation.' },
    ERROR: { icon: '⚠', color: '#dc2626', title: 'Error', message: typeof transaction === 'string' ? transaction : 'An error occurred.' }
  };
  const cfg = statusConfig[status] || statusConfig.ERROR;
  const details = typeof transaction === 'object' && transaction.transactionId ? transaction : null;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cfg.title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.container{background:#fff;border-radius:20px;padding:40px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center}
.icon{width:80px;height:80px;margin:0 auto 24px;border-radius:50%;background:${cfg.color}15;display:flex;align-items:center;justify-content:center;font-size:48px;color:${cfg.color};font-weight:700}
h1{font-size:28px;color:#1f2937;margin-bottom:12px}
.message{font-size:16px;color:#6b7280;line-height:1.6;margin-bottom:24px}
.details{background:#f9fafb;border-radius:12px;padding:20px;margin:24px 0;text-align:left}
.row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e5e7eb}
.row:last-child{border-bottom:none}
.label{color:#6b7280;font-size:14px}
.value{color:#1f2937;font-weight:600;font-size:14px}
.badge{display:inline-block;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;background:${cfg.color}15;color:${cfg.color};text-transform:uppercase}
.footer{font-size:14px;color:#9ca3af;margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb}
</style></head>
<body><div class="container">
<div class="icon">${cfg.icon}</div>
<h1>${cfg.title}</h1>
<p class="message">${cfg.message}</p>
${details ? `<div class="details">
<div class="row"><span class="label">Reference</span><span class="value">${details.transactionId}</span></div>
${details.amount ? `<div class="row"><span class="label">Amount</span><span class="value">${details.amount.toLocaleString()} ${details.currency}</span></div>` : ''}
<div class="row"><span class="label">Status</span><span class="value"><span class="badge">${status}</span></span></div>
</div>` : ''}
<div class="footer"><p>You can close this window now.</p></div>
</div></body></html>`;
}
