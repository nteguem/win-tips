/**
 * Service KoraPay (single-tenant — clés en .env).
 *
 * Cibles : NG, GH, KE, ZA, EG, CI (NGN/GHS/KES/ZAR/EGP/XOF).
 * Le webhook KoraPay arrive bien sur ce serveur, donc la logique de
 * vérification manuelle (cron) n'est PAS nécessaire ici — contrairement
 * à Maviance/Smobilpay.
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const KorapayTransaction = require('../../models/user/KorapayTransaction');
const Package = require('../../models/common/Package');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

class KorapayError extends Error {
  constructor(message, statusCode, responseData) {
    super(message);
    this.name = 'KorapayError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

function getConfig() {
  return {
    apiUrl: process.env.KORAPAY_API_URL || 'https://api.korapay.com/merchant',
    publicKey: process.env.KORAPAY_PUBLIC_KEY,
    secretKey: process.env.KORAPAY_SECRET_KEY,
    encryptionKey: process.env.KORAPAY_ENCRYPTION_KEY,
    enabled: !!(process.env.KORAPAY_PUBLIC_KEY && process.env.KORAPAY_SECRET_KEY)
  };
}

function validateConfig(config) {
  if (!config.enabled) {
    throw new KorapayError('KoraPay n\'est pas configuré (KORAPAY_PUBLIC_KEY / KORAPAY_SECRET_KEY manquants)', 500);
  }
  if (!config.apiUrl) {
    throw new KorapayError('KORAPAY_API_URL non configurée', 500);
  }
}

/**
 * Ce projet n'utilise pas le webhook KoraPay : seul le redirect_url est
 * fourni à KoraPay. La création de souscription est déclenchée par le
 * callback, le cron de vérification ou l'extension de /me.
 */
function generateRedirectUrl() {
  const baseUrl = process.env.APP_BASE_URL;
  return `${baseUrl}/api/payments/korapay/callback`;
}

function createHeaders(config) {
  return {
    'Authorization': `Bearer ${config.secretKey}`,
    'Content-Type': 'application/json'
  };
}

function mapKorapayStatus(korapayStatus) {
  const statusMap = {
    'success': 'SUCCESS',
    'processing': 'PROCESSING',
    'failed': 'FAILED',
    'pending': 'PENDING',
    'cancelled': 'CANCELLED'
  };
  return statusMap[korapayStatus?.toLowerCase()] || 'PENDING';
}

/**
 * Initie un paiement KoraPay (checkout hébergé).
 */
async function initiatePayment(userId, packageId, currency, customerName, customerEmail, customerPhone = null, merchantBearsCost = false) {
  const config = getConfig();
  validateConfig(config);

  const packageDoc = await Package.findById(packageId);
  if (!packageDoc) {
    throw new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND);
  }

  const normalizedCurrency = currency.toUpperCase();

  let amount;
  if (packageDoc.pricing instanceof Map) {
    amount = packageDoc.pricing.get(normalizedCurrency);
  } else if (packageDoc.pricing && typeof packageDoc.pricing === 'object') {
    amount = packageDoc.pricing[normalizedCurrency];
  }
  if (!amount || amount <= 0) {
    throw new AppError(`Prix ${normalizedCurrency} non disponible pour ce package`, 400, ErrorCodes.VALIDATION_ERROR);
  }

  const transactionId = `KPY_TXN_${Date.now()}_${uuidv4().substring(0, 8)}`;
  const reference = transactionId;
  const redirect_url = generateRedirectUrl();

  const transaction = new KorapayTransaction({
    transactionId,
    reference,
    user: userId,
    package: packageId,
    amount,
    currency: normalizedCurrency,
    customerName,
    customerEmail,
    customerPhone,
    description: `${packageDoc.name?.fr || packageDoc.name?.en || 'Package'} - ${packageDoc.duration} jours`,
    amountExpected: amount,
    redirectUrl: redirect_url,
    status: 'PENDING',
    merchantBearsCost
  });
  await transaction.save();

  const initializeData = {
    reference,
    amount,
    currency: normalizedCurrency,
    redirect_url,
    customer: { name: customerName, email: customerEmail },
    merchant_bears_cost: merchantBearsCost,
    metadata: {
      user_id: userId.toString(),
      package_id: packageId.toString(),
      transaction_id: transactionId
    }
  };
  if (customerPhone) initializeData.customer.phone = customerPhone;

  try {
    const response = await axios.post(
      `${config.apiUrl}/api/v1/charges/initialize`,
      initializeData,
      { headers: createHeaders(config) }
    );

    if (!response.data.status) {
      // Rollback : on supprime la transaction si KoraPay refuse
      await KorapayTransaction.findByIdAndDelete(transaction._id);
      throw new KorapayError(
        response.data.message || 'Payment initialization failed',
        response.status || 400,
        response.data
      );
    }

    const { data } = response.data;
    transaction.korapayReference = data.reference;
    transaction.checkoutUrl = data.checkout_url;
    await transaction.save();

    await transaction.populate(['package', 'user']);

    return {
      transaction,
      checkoutUrl: data.checkout_url
    };
  } catch (error) {
    if (error instanceof KorapayError || error instanceof AppError) throw error;
    if (error.response) {
      throw new KorapayError(
        error.response.data?.message || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

/**
 * Vérifie le statut d'une transaction auprès de KoraPay et met à jour la BD.
 */
async function checkTransactionStatus(reference) {
  const config = getConfig();
  validateConfig(config);

  const transaction = await KorapayTransaction.findByReference(reference);
  if (!transaction) {
    throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
  }

  const verifyReference = transaction.korapayReference || transaction.reference;

  try {
    const response = await axios.get(
      `${config.apiUrl}/api/v1/charges/${verifyReference}`,
      { headers: createHeaders(config) }
    );

    if (response.data.status && response.data.data) {
      const paymentData = response.data.data;
      transaction.status = mapKorapayStatus(paymentData.status);

      if (paymentData.payment_method) transaction.paymentMethod = paymentData.payment_method;
      if (paymentData.fee !== undefined) transaction.fee = paymentData.fee;
      if (paymentData.vat !== undefined) transaction.vat = paymentData.vat;
      if (paymentData.amount_charged !== undefined) transaction.amountCharged = paymentData.amount_charged;
      if (paymentData.reference) transaction.korapayReference = paymentData.reference;
      transaction.responseMessage = response.data.message || paymentData.status;

      if (transaction.status === 'SUCCESS' && !transaction.paymentDate) {
        transaction.paymentDate = new Date();
      }
      if (transaction.status === 'FAILED') {
        transaction.errorMessage = paymentData.message || 'Payment failed';
      }

      await transaction.save();
    }

    return transaction;
  } catch (error) {
    if (error instanceof KorapayError || error instanceof AppError) throw error;
    if (error.response) {
      throw new KorapayError(
        error.response.data?.message || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

module.exports = {
  getConfig,
  validateConfig,
  initiatePayment,
  checkTransactionStatus,
  mapKorapayStatus,
  KorapayError
};
