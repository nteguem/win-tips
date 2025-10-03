const smobilpayService = require('../../services/user/SmobilpayService');
const paymentMiddleware = require('../../middlewares/payment/paymentMiddleware');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Récupérer les services par pays
 */
exports.getServices = catchAsync(async (req, res, next) => {
  const { country } = req.query;
  
  const services = await smobilpayService.getServices(country);
  
  res.status(200).json({
    success: true,
    data: {
      services,
      count: services.length,
      country: country || 'ALL',
      availableCountries: Object.keys(smobilpayService.COUNTRY_MAPPING)
    }
  });
});



/**
 * Initier un paiement 
 */
exports.initiatePayment = catchAsync(async (req, res, next) => {
  const { packageId, serviceId, phoneNumber } = req.body;
  
  // Validation - seulement 3 champs requis
  if (!packageId || !serviceId || !phoneNumber) {
    return next(new AppError(
      'packageId, serviceId et phoneNumber sont requis',
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
  
  // Récupérer automatiquement les données de l'utilisateur connecté
  const customerData = {
    phoneNumber,
    customerName: req.user.pseudo || req.user.name || req.user.username || 'Utilisateur',
    email: req.user.email || ''
  };
    
  const transaction = await smobilpayService.initiatePayment(
    req.user._id,
    packageId,
    serviceId,
    customerData
  );
  
  res.status(201).json({
    success: true,
    message: 'Paiement initié avec succès',
    data: {
      transaction: {
        paymentId: transaction.paymentId,
        amount: transaction.amount,
        currency: transaction.currency,
        status: transaction.status,
        operatorName: transaction.operatorName,
        phoneNumber: transaction.phoneNumber,
        customerName: transaction.customerName,
        package: transaction.package
      }
    }
  });
});

/**
 * Vérifier le statut d'un paiement
 */
exports.checkStatus = catchAsync(async (req, res, next) => {
  const { paymentId } = req.params;
  
  const transaction = await smobilpayService.checkTransactionStatus(paymentId);
  
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
    // Ne pas bloquer la réponse en cas d'erreur de traitement
  }
  
  res.status(200).json({
    success: true,
    data: {
      transaction: {
        paymentId: transaction.paymentId,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        operatorName: transaction.operatorName,
        processed: transaction.processed,
        receiptNumber: transaction.receiptNumber,
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
 * Webhook pour les notifications Smobilpay
 */
exports.webhook = catchAsync(async (req, res, next) => {
  const { errorCode, status, trid: paymentId } = req.body;
  
  console.log('Smobilpay webhook received:', req.body);

  if (!paymentId) {
    return next(new AppError('PTN ou paymentId requis', 400, ErrorCodes.VALIDATION_ERROR));
  }
  
  try {
    // Chercher la transaction
    const SmobilpayTransaction = require('../../models/user/SmobilpayTransaction');
    const query = { paymentId };
    const transaction = await SmobilpayTransaction.findOne(query)
      .populate(['package', 'user']);
    
    if (!transaction) {
      return next(new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND));
    }
    
    // Mettre à jour le statut si différent
    if (transaction.status !== status) {
      transaction.status = status;
      transaction.errorCode = errorCode || null;
      await transaction.save();
      
      // Traiter la transaction mise à jour
      await paymentMiddleware.processTransactionUpdate(transaction);
    }
    
    res.status(200).json({
      success: true,
      message: 'Webhook traité avec succès'
    });
  } catch (error) {
    console.error('Webhook processing error:', error.message);
    
    // Retourner succès même en cas d'erreur pour éviter les retry excessifs
    res.status(200).json({
      success: false,
      message: 'Erreur lors du traitement du webhook',
      error: error.message
    });
  }
});