// controllers/user/pawapayController.js
//
// Controller pawaPay — collecte mobile money (deposits). Mono-tenant.
// Routes :
//   GET  /payments/pawapay/providers          (public — selecteur mobile)
//   POST /payments/pawapay/initiate           (auth user)
//   GET  /payments/pawapay/status/:depositId  (auth user)
//   POST /payments/pawapay/webhook            (public — pawaPay callback)
//
// Note : pas de page success/failed HTTP. pawaPay est full-API (push USSD
// au telephone du client), pas de redirection navigateur.

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
  const { packageId, phoneNumber, operator, country, provider } = req.body;

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
    req.user, packageId, phoneNumber, operator, country, provider
  );

  res.status(201).json({
    success: true,
    message: 'Paiement initie — un push USSD a ete envoye sur le telephone du client',
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
        package:           result.transaction.package
      }
    }
  });
});

// ---------------------------------------------
//  VERIFIER LE STATUT
// ---------------------------------------------
exports.checkStatus = catchAsync(async (req, res, next) => {
  const { depositId } = req.params;

  const transaction = await pawapayService.checkTransactionStatus(depositId);

  if (transaction.user._id.toString() !== req.user._id.toString()) {
    return next(new AppError('Transaction non autorisee', 403, ErrorCodes.UNAUTHORIZED));
  }

  let subscription = null;
  try {
    subscription = await paymentMiddleware.processTransactionUpdate(transaction);
  } catch (err) {
    console.error('[pawapay] checkStatus: processTransactionUpdate failed', err.message);
  }

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
        failureCode:    transaction.failureCode,
        failureMessage: transaction.failureMessage,
        createdAt:      transaction.createdAt,
        package:        transaction.package
      },
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
//  (incluant status COMPLETED ou FAILED). La signature RFC 9421 sera
//  validee plus tard (cle publique a fournir). En attendant on applique
//  le pattern CinetPay : re-verifier systematiquement via check_status.
// ---------------------------------------------
exports.webhook = catchAsync(async (req, res, next) => {
  const depositId = req.body?.depositId;
  const webhookStatus = req.body?.status;

  console.log(`[pawapay] webhook: received depositId=${depositId} status=${webhookStatus}`);

  if (!depositId) {
    return res.status(200).json({ success: false, message: 'depositId manquant' });
  }

  try {
    const transaction = await PawapayTransaction.findOne({ depositId });
    if (!transaction) {
      console.warn(`[pawapay] webhook: transaction not found depositId=${depositId}`);
      return res.status(200).json({ success: false, message: 'Transaction non trouvee' });
    }

    if (transaction.processed) {
      console.log(`[pawapay] webhook: already processed (idempotency) depositId=${depositId}`);
      return res.status(200).json({ success: true, message: 'Deja traite' });
    }

    // Defense en profondeur : on ne fait pas confiance au body brut tant
    // que la verification de signature RFC 9421 n'est pas finalisee.
    const updatedTransaction = await pawapayService.checkTransactionStatus(depositId);

    console.log(`[pawapay] webhook: transaction updated depositId=${depositId} finalStatus=${updatedTransaction.status}`);

    if (updatedTransaction.status === 'SUCCESS' || updatedTransaction.status === 'FAILED' || updatedTransaction.status === 'EXPIRED') {
      await paymentMiddleware.processTransactionUpdate(updatedTransaction);
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook traite',
      status:  updatedTransaction.status
    });
  } catch (error) {
    console.error(`[pawapay] webhook: processing failed depositId=${depositId} message=${error.message}`);
    // Toujours 200 pour eviter les retries infinis cote pawaPay
    return res.status(200).json({ success: false, message: error.message });
  }
});

module.exports = {
  getProviders:    exports.getProviders,
  initiatePayment: exports.initiatePayment,
  checkStatus:     exports.checkStatus,
  webhook:         exports.webhook
};
