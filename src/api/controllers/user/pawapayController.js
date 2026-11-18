// controllers/user/pawapayController.js
//
// Controller pawaPay — collecte mobile money (deposits). Mono-tenant.
// Routes :
//   GET  /payments/pawapay/providers          (public — selecteur mobile)
//   POST /payments/pawapay/initiate           (auth user)
//   GET  /payments/pawapay/status/:depositId  (auth user)
//   POST /payments/pawapay/webhook            (public — pawaPay callback)
//
// Certains opérateurs demandent une autorisation navigateur. Leur page de
// retour n'est jamais utilisée comme preuve du paiement.

const pawapayService = require('../../services/user/PawapayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');
const PawapayTransaction = require('../../models/user/PawapayTransaction');

// ---------------------------------------------
//  LISTER LES PROVIDERS (publique — pour peupler le selecteur mobile)
//
//  GET /providers              → liste des pays disponibles + currency par pays
//  GET /providers?country=CM   → detail d'un pays (providers, displayName, flag,
//                                 currency) + availableCountries pour fallback
//
//  Source : pawaPay GET /v2/active-conf, cache 1h en memoire.
// ---------------------------------------------
exports.getProviders = catchAsync(async (req, res, next) => {
  const { country } = req.query;
  const data = await pawapayService.getProvidersAsync(country);
  res.status(200).json({ success: true, data });
});

// ---------------------------------------------
//  INITIER UN PAIEMENT (deposit)
// ---------------------------------------------
exports.initiatePayment = catchAsync(async (req, res, next) => {
  // Inputs :
  //   - packageId       (required)
  //   - phoneNumber     (required, format international: +237..., 237...)
  //   - operator        (required SAUF si provider explicite — mtn/om/airtel/mpesa/...)
  //   - country         (optionnel — ISO-2; deduit du phoneNumber si absent)
  //   - provider        (optionnel — bypass operator+country, ex: 'MTN_MOMO_CMR')
  const { packageId, phoneNumber, operator, country, provider, preAuthorisationCode } = req.body;

  if (!packageId || !phoneNumber) {
    return next(new AppError('packageId et phoneNumber sont requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  if (!operator && !provider) {
    return next(new AppError('operator ou provider est requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Verifier abonnement actif pour ce package
  const subscriptionService = require('../../services/user/subscriptionService');
  const activeSubs = await subscriptionService.getActiveSubscriptions(req.user._id);
  const hasActive = activeSubs.some(sub => sub.package && sub.package._id.toString() === packageId);
  if (hasActive) {
    return next(new AppError('Vous avez deja un abonnement actif pour ce package', 400, ErrorCodes.VALIDATION_ERROR));
  }

  const result = await pawapayService.initiatePayment(
    req.user, packageId, phoneNumber, operator, country, provider,
    { preAuthorisationCode }
  );

  res.status(201).json({
    success: true,
    message: 'Paiement initié. Suivez les instructions pour le confirmer.',
    data: {
      transaction: {
        depositId:         result.transaction.depositId,
        clientReferenceId: result.transaction.clientReferenceId,
        amount:            result.transaction.amount,
        currency:          result.transaction.currency,
        status:            result.transaction.status,
        provider:          result.transaction.provider,
        countryCode:       result.transaction.countryCode,
        phoneNumber:       result.transaction.phoneNumber,
        environment:       result.transaction.environment,
        authorizationUrl:  result.authorizationUrl || result.transaction.authorizationUrl || null,
        package:           result.transaction.package
      },
      authorizationUrl: result.authorizationUrl || result.transaction.authorizationUrl || null
    }
  });
});

// ---------------------------------------------
//  VERIFIER LE STATUT
// ---------------------------------------------
exports.checkStatus = catchAsync(async (req, res, next) => {
  const { depositId } = req.params;

  // The service scopes its database lookup before any provider request/write.
  const transaction = await pawapayService.checkTransactionStatus(depositId, { userId: req.user._id });
  const subscription = await paymentMiddleware.processTransactionUpdate(transaction);

  res.status(200).json({
    success: true,
    data: {
      transaction: {
        depositId:      transaction.depositId,
        status:         transaction.status,
        amount:         transaction.amount,
        currency:       transaction.currency,
        provider:       transaction.provider,
        countryCode:    transaction.countryCode,
        phoneNumber:    transaction.phoneNumber,
        environment:    transaction.environment,
        processed:      transaction.processed,
        subscriptionActivated: transaction.status === 'SUCCESS' && transaction.processed === true,
        authorizationUrl: transaction.authorizationUrl || null,
        failureCode:    transaction.failureCode,
        failureMessage: transaction.failureMessage,
        createdAt:      transaction.createdAt,
        package:        transaction.package
      },
      authorizationUrl: transaction.authorizationUrl || null,
      subscription: subscription ? {
        id:        subscription._id,
        startDate: subscription.startDate,
        endDate:   subscription.endDate,
        status:    subscription.status
      } : null
    }
  });
});

// ---------------------------------------------
//  WEBHOOK (callback pawaPay)
//
//  pawaPay envoie une notif POST avec le payload final de la transaction
//  (incluant status COMPLETED ou FAILED). Le body identifie la transaction,
//  puis seul le GET authentifié au PSP peut confirmer son statut et montant.
// ---------------------------------------------
exports.webhook = catchAsync(async (req, res, next) => {
  const depositId = req.body?.depositId;
  if (typeof depositId !== 'string' || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(depositId)) {
    return res.status(200).json({ success: true, ignored: true });
  }

  try {
    const transaction = await PawapayTransaction.findOne({ depositId });
    if (!transaction) {
      return res.status(200).json({ success: true, ignored: true });
    }

    // Defense en profondeur : on ne fait pas confiance au body brut tant
    // que la verification de signature RFC 9421 n'est pas finalisee.
    const updatedTransaction = await pawapayService.checkTransactionStatus(depositId);

    // A final callback can race the provider's read API. Do not lose that
    // callback while its authenticated receipt is still pending/not found.
    // An authorization/progress callback remains a normal acknowledgement.
    if (['COMPLETED', 'FAILED', 'EXPIRED'].includes(req.body?.status) &&
        !['SUCCESS', 'FAILED', 'EXPIRED'].includes(updatedTransaction.status)) {
      return res.status(503).json({ success: false, message: 'Payment verification pending' });
    }

    await paymentMiddleware.processTransactionUpdate(updatedTransaction);

    return res.status(200).json({
      success: true,
      message: 'Webhook traite',
      status:  updatedTransaction.status
    });
  } catch (error) {
    console.error('[pawapay] webhook: verification or activation pending');
    // An outage is retryable. Acknowledging it with 200 would lose the callback.
    return res.status(503).json({ success: false, message: 'Payment verification pending' });
  }
});

// No state mutation, activation, or success inference from browser query data.
exports.paymentReturn = (req, res) => {
  const french = req.query?.lang === 'fr';
  const title = french ? 'Vérifiez votre paiement dans WinTips' : 'Check your payment in WinTips';
  const message = french
    ? 'Revenez dans WinTips pour vérifier le paiement et votre accès VIP. Vous pouvez fermer cette page.'
    : 'Return to WinTips to check your payment and VIP access. You can close this page.';
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return res.status(200).type('html').send(`<!doctype html><html lang="${french ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WinTips</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#143047;font:16px/1.6 system-ui,sans-serif}main{max-width:420px;margin:24px;padding:28px;background:white;border-radius:20px}h1{font-size:24px;line-height:1.3}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`);
};

module.exports = {
  getProviders:    exports.getProviders,
  initiatePayment: exports.initiatePayment,
  checkStatus:     exports.checkStatus,
  webhook:         exports.webhook,
  paymentReturn:   exports.paymentReturn
};
