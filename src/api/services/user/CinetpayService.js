// services/user/CinetpayService.js
//
// Intégration de la nouvelle API CinetPay (api.cinetpay.co/v1) :
//   - POST /v1/oauth/login  → token JWT
//   - POST /v1/payment      → init paiement, renvoie payment_url
//   - GET  /v1/payment/:id  → statut de la transaction
//
// win_tips est mono-tenant → la config (api_key / api_password) est lue
// directement depuis le `.env`, par devise :
//   CINETPAY_API_URL, CINETPAY_XOF_API_KEY, CINETPAY_XOF_API_PASSWORD, …
//
// Le token JWT est mis en cache in-memory par devise (TTL 23h).

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const CinetpayTransaction = require('../../models/user/CinetpayTransaction');
const Package = require('../../models/common/Package');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const logger = require('../../../utils/logger');

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const DEFAULT_API_URL = 'https://api.cinetpay.co';

class CinetpayError extends Error {
  constructor(message, statusCode, responseData) {
    super(message);
    this.name = 'CinetpayError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

// Cache JWT : Map<currency, { token, expiresAt }>
const tokenCache = new Map();

function getConfig() {
  return {
    apiUrl: process.env.CINETPAY_API_URL || DEFAULT_API_URL,
    xof: {
      apiKey: process.env.CINETPAY_XOF_API_KEY,
      apiPassword: process.env.CINETPAY_XOF_API_PASSWORD
    },
    xaf: {
      apiKey: process.env.CINETPAY_XAF_API_KEY,
      apiPassword: process.env.CINETPAY_XAF_API_PASSWORD
    },
    gnf: {
      apiKey: process.env.CINETPAY_GNF_API_KEY,
      apiPassword: process.env.CINETPAY_GNF_API_PASSWORD
    },
    cdf: {
      apiKey: process.env.CINETPAY_CDF_API_KEY,
      apiPassword: process.env.CINETPAY_CDF_API_PASSWORD
    }
  };
}

function getCredentialsForCurrency(config, currency) {
  const key = String(currency).toLowerCase();
  const creds = config[key];
  if (!creds || !creds.apiKey || !creds.apiPassword) {
    throw new CinetpayError(
      `Credentials CinetPay ${currency} manquants. Configurez CINETPAY_${String(currency).toUpperCase()}_API_KEY et CINETPAY_${String(currency).toUpperCase()}_API_PASSWORD dans le .env`,
      500
    );
  }
  return creds;
}

function validateConfig(config, currency) {
  if (!config.apiUrl) {
    throw new CinetpayError('CINETPAY_API_URL non configurée', 500);
  }
  getCredentialsForCurrency(config, currency);
}

function detectCurrencyFromPhone(phoneNumber) {
  const cleanPhone = String(phoneNumber || '').replace(/[\s\-()]/g, '');

  // XAF (CEMAC) : Cameroun, Gabon, RCA, Congo, Tchad, Guinée Équatoriale
  const xafPrefixes = ['+237', '237', '+241', '241', '+236', '236', '+242', '242', '+235', '235', '+240', '240'];
  if (xafPrefixes.some(p => cleanPhone.startsWith(p))) return 'XAF';

  // GNF : Guinée
  if (cleanPhone.startsWith('+224') || cleanPhone.startsWith('224')) return 'GNF';

  // CDF : RDC
  if (cleanPhone.startsWith('+243') || cleanPhone.startsWith('243')) return 'CDF';

  // Par défaut XOF (UEMOA : CI, SN, BJ, BF, ML, NE, TG)
  return 'XOF';
}

/**
 * merchant_transaction_id <= 30 chars.
 * Pattern : `WT-<BASE36-UPPER>-<6HEX-UPPER>` ≈ 18 chars.
 * CinetPay rejette les underscores et minuscules (1004 INVALID_PARAMS).
 */
function generateMerchantTransactionId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = uuidv4().replace(/-/g, '').substring(0, 6).toUpperCase();
  return `WT-${ts}-${rand}`;
}

function generateUrls() {
  const baseUrl = process.env.APP_BASE_URL;
  return {
    notify_url: `${baseUrl}/api/payments/cinetpay/notify`,
    success_url: `${baseUrl}/api/payments/cinetpay/return?status=success`,
    failed_url: `${baseUrl}/api/payments/cinetpay/return?status=failed`
  };
}

async function getAccessToken(currency) {
  const config = getConfig();
  validateConfig(config, currency);

  const creds = getCredentialsForCurrency(config, currency);
  const key = String(currency).toUpperCase();
  const cached = tokenCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const response = await axios.post(
      `${config.apiUrl}/v1/oauth/login`,
      { api_key: creds.apiKey, api_password: creds.apiPassword },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (response.data?.code !== 200 || !response.data.access_token) {
      throw new CinetpayError(
        response.data?.description || 'Authentification CinetPay échouée',
        response.status || 401,
        response.data
      );
    }

    const token = response.data.access_token;
    tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    logger.info(`[cinetpay] oauth: token obtenu (${key})`);
    return token;
  } catch (error) {
    logger.error(`[cinetpay] oauth: échec (${key}) — ${error.message} ${JSON.stringify(error.response?.data || {})}`);
    if (error instanceof CinetpayError) throw error;
    throw new CinetpayError(
      error.response?.data?.description || error.message,
      error.response?.status || 500,
      error.response?.data
    );
  }
}

function invalidateToken(currency) {
  tokenCache.delete(String(currency).toUpperCase());
}

function isInvalidTokenError(error) {
  // CinetPay renvoie 401 ET aussi 422 avec status=INVALID_TOKEN dans le body.
  if (error.response?.status === 401) return true;
  const data = error.response?.data;
  if (data?.status === 'INVALID_TOKEN' || data?.code === 1002) return true;
  if (data?.details?.status === 'INVALID_TOKEN' || data?.details?.code === 1002) return true;
  return false;
}

async function callWithToken(currency, requestFn) {
  let token = await getAccessToken(currency);
  try {
    return await requestFn(token);
  } catch (error) {
    if (isInvalidTokenError(error)) {
      logger.warn(`[cinetpay] token invalide détecté → refresh (${currency})`);
      invalidateToken(currency);
      token = await getAccessToken(currency);
      return await requestFn(token);
    }
    throw error;
  }
}

function mapStatus(rawStatus) {
  switch ((rawStatus || '').toUpperCase()) {
    case 'SUCCESS':
    case 'ACCEPTED':
      return 'ACCEPTED';
    case 'FAILED':
    case 'REFUSED':
      return 'REFUSED';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELED';
    case 'PENDING':
    case 'WAITING':
    case 'WAITING_FOR_CUSTOMER':
      return 'WAITING_FOR_CUSTOMER';
    case 'INITIATED':
      return 'INITIATED';
    default:
      return 'PENDING';
  }
}

/**
 * Choisit la devise :
 *   1. `requestedCurrency` explicite (passé par le mobile)
 *   2. sinon détection via préfixe `phoneNumber`
 *   3. sinon première devise avec credentials dans le .env
 */
function resolveCurrency(config, requestedCurrency, phoneNumber) {
  if (requestedCurrency) {
    return String(requestedCurrency).toUpperCase();
  }
  if (phoneNumber) {
    return detectCurrencyFromPhone(phoneNumber);
  }
  for (const ccy of ['xof', 'xaf', 'gnf', 'cdf']) {
    if (config[ccy]?.apiKey && config[ccy]?.apiPassword) {
      return ccy.toUpperCase();
    }
  }
  return 'XOF';
}

async function initiatePayment(userId, packageId, phoneNumber, customerName, email, requestedCurrency) {
  logger.info(`[cinetpay] initiate: start userId=${userId} packageId=${packageId}`);

  const config = getConfig();

  const packageDoc = await Package.findById(packageId);
  if (!packageDoc) {
    throw new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND);
  }

  const currency = resolveCurrency(config, requestedCurrency, phoneNumber);
  validateConfig(config, currency);

  const amount = packageDoc.pricing instanceof Map
    ? packageDoc.pricing.get(currency)
    : packageDoc.pricing?.[currency];
  if (!amount || amount <= 0) {
    throw new AppError(`Prix ${currency} non disponible pour ce package`, 400, ErrorCodes.VALIDATION_ERROR);
  }

  const merchantTransactionId = generateMerchantTransactionId();
  const { notify_url, success_url, failed_url } = generateUrls();
  const designation = `${packageDoc.name?.fr || packageDoc.name?.en || packageDoc.name || 'Package'} - ${packageDoc.duration} jours`;

  const transaction = new CinetpayTransaction({
    transactionId: merchantTransactionId,
    user: userId,
    package: packageId,
    amount,
    currency,
    phoneNumber: phoneNumber || undefined,
    customerName,
    description: designation,
    notifyUrl: notify_url,
    returnUrl: success_url,
    status: 'PENDING'
  });
  await transaction.save();

  // CinetPay impose client_first_name ET client_last_name (min 2 chars
  // non-blancs). Pseudo en 1 mot → on duplique dans les 2 champs.
  const fullName = String(customerName || 'Utilisateur').trim();
  const nameParts = fullName.split(/\s+/);
  let firstName, lastName;
  if (nameParts.length >= 2) {
    firstName = nameParts[0];
    lastName = nameParts.slice(1).join(' ');
  } else {
    firstName = fullName;
    lastName = fullName;
  }
  firstName = firstName.length < 2 ? firstName.padEnd(2, '_') : firstName.slice(0, 255);
  lastName = lastName.length < 2 ? lastName.padEnd(2, '_') : lastName.slice(0, 255);

  // client_phone_number non transmis (optionnel quand direct_pay=false) :
  // le client le saisit sur la page hostée CinetPay.
  const payload = {
    currency,
    merchant_transaction_id: merchantTransactionId,
    amount,
    lang: 'fr',
    designation,
    client_first_name: firstName,
    client_last_name: lastName,
    client_email: email || 'no-reply@proxidream.com',
    success_url,
    failed_url,
    notify_url,
    direct_pay: false
  };

  try {
    const response = await callWithToken(currency, (token) =>
      axios.post(`${config.apiUrl}/v1/payment`, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        timeout: 20000
      })
    );

    const body = response.data;
    if (body?.code !== 200 || !body.payment_url) {
      logger.error(`[cinetpay] initiate: API rejected — ${JSON.stringify(body)}`);
      await CinetpayTransaction.findByIdAndDelete(transaction._id);
      throw new CinetpayError(
        body?.description || body?.details?.message || 'Initialisation du paiement échouée',
        response.status || 400,
        body
      );
    }

    transaction.cinetpayTransactionId = body.transaction_id;
    transaction.paymentToken = body.payment_token;
    transaction.notifyToken = body.notify_token;
    transaction.paymentUrl = body.payment_url;
    transaction.status = mapStatus(body.details?.status || 'INITIATED');
    transaction.detailsCode = body.details?.code;
    transaction.detailsStatus = body.details?.status;
    transaction.detailsMessage = body.details?.message;
    transaction.mustBeRedirected = body.details?.must_be_redirected;
    await transaction.save();

    await transaction.populate(['package', 'user']);
    logger.info(`[cinetpay] initiate: success ${merchantTransactionId} ${amount} ${currency}`);

    return { transaction, paymentUrl: body.payment_url };
  } catch (error) {
    logger.error(`[cinetpay] initiate: failed — ${error.message} ${JSON.stringify(error.response?.data || {})}`);
    await CinetpayTransaction.findByIdAndDelete(transaction._id).catch(() => {});
    if (error instanceof CinetpayError || error instanceof AppError) throw error;
    if (error.response) {
      throw new CinetpayError(
        error.response.data?.description || error.response.data?.message || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

async function checkTransactionStatus(merchantTransactionId) {
  const config = getConfig();

  const transaction = await CinetpayTransaction.findOne({ transactionId: merchantTransactionId })
    .populate(['package', 'user']);
  if (!transaction) {
    throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
  }

  validateConfig(config, transaction.currency);

  try {
    const response = await callWithToken(transaction.currency, (token) =>
      axios.get(`${config.apiUrl}/v1/payment/${encodeURIComponent(merchantTransactionId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000
      })
    );

    const body = response.data;
    logger.info(`[cinetpay] checkStatus: ${merchantTransactionId} code=${body?.code} status=${body?.status}`);

    transaction.status = mapStatus(body?.status);
    transaction.detailsCode = body?.code;
    transaction.detailsStatus = body?.status;
    transaction.detailsMessage = body?.message;
    if (body?.transaction_id) transaction.cinetpayTransactionId = body.transaction_id;
    if (body?.payment_method) transaction.paymentMethod = body.payment_method;
    if (body?.code && body.code !== 100 && body.code !== 200) {
      transaction.errorCode = String(body.code);
      transaction.errorMessage = body?.message;
    }

    await transaction.save();
    return transaction;
  } catch (error) {
    logger.error(`[cinetpay] checkStatus: failed — ${error.message}`);
    if (error instanceof CinetpayError || error instanceof AppError) throw error;
    if (error.response) {
      throw new CinetpayError(
        error.response.data?.description || error.response.data?.message || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

module.exports = {
  detectCurrencyFromPhone,
  getAccessToken,
  initiatePayment,
  checkTransactionStatus,
  CinetpayError
};
