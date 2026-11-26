// Explicit adapters for CinetPay Checkout v2 (apikey/site_id) and API v1
// (api_key/api_password). A legacy secret is never an OAuth password.
const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const CinetpayTransaction = require('../../models/user/CinetpayTransaction');
const Package = require('../../models/common/Package');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const safety = require('./paymentTransactionSafety');
const agentIPv4 = new https.Agent({ family: 4, keepAlive: true });
const tokenCache = new Map();
const FAILURE_GRACE_MS = 30 * 60 * 1000;

class CinetpayError extends Error {
  constructor(message, statusCode = 502, responseData) {
    super(message); this.name = 'CinetpayError'; this.statusCode = statusCode; this.responseData = responseData;
  }
}

function getConfig() {
  const config = { apiUrl: process.env.CINETPAY_API_URL?.replace(/\/$/, ''), apiVersion: process.env.CINETPAY_API_VERSION };
  for (const currency of ['XOF', 'XAF', 'GNF', 'CDF']) {
    config[currency.toLowerCase()] = {
      apiKey: process.env[`CINETPAY_${currency}_API_KEY`],
      apiPassword: process.env[`CINETPAY_${currency}_API_PASSWORD`],
      siteId: process.env[`CINETPAY_${currency}_SITE_ID`]
    };
  }
  return config;
}

function getAdapter(config, currency, savedVersion) {
  const credentials = config[String(currency).toLowerCase()] || {};
  let apiVersion = savedVersion || config.apiVersion;
  if (!apiVersion) {
    apiVersion = config.apiUrl?.includes('api-checkout.cinetpay.com') ? 'legacy-v2' : credentials.apiPassword ? 'v1' : 'legacy-v2';
  }
  if (!['legacy-v2', 'v1'].includes(apiVersion)) throw new CinetpayError('Version CinetPay non prise en charge', 503);
  const apiUrl = config.apiUrl || (apiVersion === 'legacy-v2' ? 'https://api-checkout.cinetpay.com' : 'https://api.cinetpay.co');
  let host;
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
    host = parsed.hostname;
  } catch (_) { throw new CinetpayError('URL CinetPay non configurée', 503); }
  if (apiVersion === 'legacy-v2' ? host !== 'api-checkout.cinetpay.com' : !['api.cinetpay.co', 'api.cinetpay.net'].includes(host)) {
    throw new CinetpayError('Le domaine et le contrat CinetPay ne correspondent pas', 503);
  }
  if (!credentials.apiKey || (apiVersion === 'v1' ? !credentials.apiPassword : !credentials.siteId)) {
    throw new CinetpayError(`Le paiement CinetPay ${currency} est momentanément indisponible`, 503);
  }
  return { ...credentials, apiVersion, apiUrl };
}

function detectCurrencyFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (['237', '241', '236', '242', '235', '240'].some(prefix => digits.startsWith(prefix))) return 'XAF';
  if (digits.startsWith('224')) return 'GNF';
  if (digits.startsWith('243')) return 'CDF';
  return 'XOF';
}

function resolveCurrency(config, requestedCurrency, phone) {
  if (requestedCurrency) return String(requestedCurrency).toUpperCase();
  if (phone) return detectCurrencyFromPhone(phone);
  for (const currency of ['XOF', 'XAF', 'GNF', 'CDF']) {
    try { getAdapter(config, currency); return currency; } catch (_) { /* Next configured wallet. */ }
  }
  throw new CinetpayError('Le paiement CinetPay est momentanément indisponible', 503);
}

function requestOptions(extra = {}) {
  return { timeout: 15000, httpsAgent: agentIPv4, headers: { 'Content-Type': 'application/json' }, ...extra };
}

function isInvalidTokenError(error) {
  const data = error.response?.data || error.responseData || {};
  return error.response?.status === 401 || [data, data.details].filter(Boolean).some(value =>
    ['INVALID_TOKEN', 'EXPIRED_TOKEN'].includes(String(value.status).toUpperCase()) || ['1002', '1003'].includes(String(value.code)));
}

async function getAccessToken(currency, adapter = getAdapter(getConfig(), currency)) {
  if (adapter.apiVersion !== 'v1') throw new CinetpayError('OAuth non disponible pour Checkout v2', 500);
  const key = `${currency}:${adapter.apiUrl}:${adapter.apiKey}`;
  const cached = tokenCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.token;
  const response = await axios.post(`${adapter.apiUrl}/v1/oauth/login`, {
    api_key: adapter.apiKey, api_password: adapter.apiPassword
  }, requestOptions());
  if (Number(response.data?.code) !== 200 || !response.data?.access_token) throw new CinetpayError('Authentification CinetPay indisponible', 502);
  tokenCache.set(key, { token: response.data.access_token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 });
  return response.data.access_token;
}

async function callWithToken(currency, adapter, operation) {
  let token = await getAccessToken(currency, adapter);
  const invoke = async value => {
    const response = await operation(value);
    if (isInvalidTokenError({ response })) throw Object.assign(new Error('CinetPay token expired'), { response });
    return response;
  };
  try { return await invoke(token); } catch (error) {
    if (!isInvalidTokenError(error)) throw error;
    tokenCache.delete(`${currency}:${adapter.apiUrl}:${adapter.apiKey}`);
    token = await getAccessToken(currency, adapter);
    return invoke(token);
  }
}

function isVerifiedNotFound(body) {
  return body && typeof body === 'object' && Number(body.code) === 404 &&
    [body.status, body.message, body.description].some(value => String(value || '').toUpperCase() === 'NOT_FOUND');
}

function verifiedCheckoutUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && ['cinetpay.co', 'cinetpay.com', 'cinetpay.net'].some(host =>
      parsed.hostname === host || parsed.hostname.endsWith('.' + host)) ? value : null;
  } catch (_) { return null; }
}

function mapStatus(raw, code, createdAt) {
  const status = String(raw || '').toUpperCase();
  if (['SUCCESS', 'ACCEPTED', 'VALIDATED'].includes(status)) return 'ACCEPTED';
  if (['CANCELED', 'CANCELLED'].includes(status)) return 'CANCELED';
  if (['REFUSED', 'INSUFFICIENT_BALANCE', 'PAYMENT_NOT_APPROVED'].includes(status)) return 'REFUSED';
  if (status === 'FAILED' || Number(code) === 2010) {
    return Date.now() - new Date(createdAt).getTime() < FAILURE_GRACE_MS ? 'WAITING_FOR_CUSTOMER' : 'REFUSED';
  }
  if (['PENDING', 'WAITING', 'WAITING_FOR_CUSTOMER'].includes(status)) return 'WAITING_FOR_CUSTOMER';
  if (status === 'INITIATED') return 'INITIATED';
  return 'PENDING';
}

function receiptMatches(transaction, body, apiVersion) {
  const receipt = apiVersion === 'legacy-v2' ? body.data : body;
  if (!receipt || typeof receipt !== 'object') return false;
  if (apiVersion === 'legacy-v2') {
    // The authenticated check request names the transaction. v2 does not
    // necessarily echo its ID, but must return its settled amount and currency.
    if (!Number.isFinite(Number(receipt.amount)) || Number(receipt.amount) !== Number(transaction.amount) || receipt.currency !== transaction.currency) return false;
    if (receipt.transaction_id && receipt.transaction_id !== transaction.transactionId) return false;
  } else {
    // v1's official status schema does not include amount/currency. Correlate
    // merchant ID and PSP ID; reconcile monetary fields when supplied.
    if (Number(receipt.code) !== 100 || receipt.merchant_transaction_id !== transaction.transactionId) return false;
    if (transaction.cinetpayTransactionId && receipt.transaction_id !== transaction.cinetpayTransactionId) return false;
    if (receipt.amount != null && Number(receipt.amount) !== Number(transaction.amount)) return false;
    if (receipt.currency != null && receipt.currency !== transaction.currency) return false;
  }
  return true;
}

async function initiatePayment(userId, packageId, phoneNumber, customerName, email, requestedCurrency, requestedReference) {
  const config = getConfig();
  const currency = resolveCurrency(config, requestedCurrency, phoneNumber);
  const adapter = getAdapter(config, currency);
  const clientReference = safety.validateClientReference(requestedReference);
  const transactionId = clientReference ? safety.referenceId('cinetpay', userId, clientReference) : `PF${uuidv4().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
  const existing = await CinetpayTransaction.findOne({ transactionId });
  if (existing) {
    safety.assertSamePurchase(existing, packageId, { currency });
    if (existing.initiationPhase === 'PREPARED') return submitPreparedPayment(existing, getAdapter(config, currency, existing.apiVersion));
    return { transaction: existing, paymentUrl: existing.paymentUrl || null, pending: existing.verificationPending === true };
  }
  const packageDoc = await Package.findById(packageId);
  if (!packageDoc || packageDoc.isActive === false || packageDoc.paymentMode === 'ads') throw new AppError('Package non disponible', 404, ErrorCodes.NOT_FOUND);
  const amount = Number(packageDoc.pricing?.get ? packageDoc.pricing.get(currency) : packageDoc.pricing?.[currency]);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(`Prix ${currency} non disponible`, 400, ErrorCodes.VALIDATION_ERROR);
  const baseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(baseUrl)) throw new CinetpayError('Le paiement CinetPay est momentanément indisponible', 503);
  const notifyUrl = `${baseUrl}/api/payments/cinetpay/notify`;
  const returnUrl = `${baseUrl}/api/payments/cinetpay/return`;
  const description = `${packageDoc.name?.fr || packageDoc.name?.en || 'Accès'} - ${packageDoc.duration} jours`.slice(0, 255);
  let transaction = new CinetpayTransaction({ transactionId, clientReference, apiVersion: adapter.apiVersion,
    user: userId, package: packageId, amount, currency, phoneNumber: phoneNumber || undefined,
    initiationPhase: 'PREPARED', customerEmail: email || undefined,
    customerName: customerName || 'Utilisateur', description, notifyUrl, returnUrl, status: 'PENDING',
    paymentSnapshot: safety.snapshot(packageDoc, amount, currency) });
  try { await transaction.save(); } catch (error) {
    if (error.code !== 11000 || !clientReference) throw error;
    const winner = await CinetpayTransaction.findOne({ transactionId });
    if (!winner) throw error;
    safety.assertSamePurchase(winner, packageId, { currency });
    if (winner.initiationPhase === 'PREPARED') return submitPreparedPayment(winner, adapter);
    return { transaction: winner, paymentUrl: winner.paymentUrl || null, pending: true };
  }
  return submitPreparedPayment(transaction, adapter);
}

async function submitPreparedPayment(transaction, adapter) {
  const claimed = await CinetpayTransaction.findOneAndUpdate({ _id: transaction._id, initiationPhase: 'PREPARED' },
    { $set: { initiationPhase: 'SUBMITTING', initiationClaimedAt: new Date(), retryable: false }, $inc: { initiationAttempts: 1 } }, { new: true });
  if (!claimed) return { transaction: await CinetpayTransaction.findById(transaction._id), paymentUrl: null, pending: true };
  transaction = claimed;
  const { transactionId, amount, currency, phoneNumber, customerName, description, notifyUrl, returnUrl, customerEmail: email } = transaction;
  const names = String(customerName || 'Utilisateur').trim().split(/\s+/);
  const first = names[0].padEnd(2, ' ').slice(0, 255);
  const last = (names.slice(1).join(' ') || names[0]).padEnd(2, ' ').slice(0, 255);
  try {
    let response;
    if (adapter.apiVersion === 'legacy-v2') {
      response = await axios.post(`${adapter.apiUrl}/v2/payment`, {
        apikey: adapter.apiKey, site_id: adapter.siteId, transaction_id: transactionId,
        amount, currency, description, customer_name: first, customer_surname: last,
        customer_email: email || '', customer_phone_number: phoneNumber || '',
        notify_url: notifyUrl, return_url: returnUrl, channels: 'MOBILE', lang: 'FR',
        metadata: transactionId
      }, requestOptions({ timeout: 20000 }));
    } else {
      response = await callWithToken(currency, adapter, token => axios.post(`${adapter.apiUrl}/v1/payment`, {
        currency, merchant_transaction_id: transactionId, amount, lang: 'fr', designation: description,
        client_first_name: first, client_last_name: last, client_email: email || 'no-reply@proxidream.com',
        success_url: returnUrl, failed_url: returnUrl, notify_url: notifyUrl, direct_pay: false, channel: 'PUSH'
      }, requestOptions({ timeout: 20000, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })));
    }
    const body = response.data || {};
    const data = adapter.apiVersion === 'legacy-v2' ? body.data || {} : body;
    const acceptedCode = adapter.apiVersion === 'legacy-v2' ? ['201', '00'].includes(String(body.code)) : Number(body.code) === 200;
    if (!acceptedCode || !verifiedCheckoutUrl(data.payment_url)) {
      const definitive = ['600', '602', '608', '609', '613', '627', '701', '1004'].includes(String(body.code));
      transaction = await safety.updateStatus(CinetpayTransaction, transaction, definitive ? 'REFUSED' : 'PENDING', {
        verificationPending: !definitive, initiationPhase: definitive ? 'REJECTED' : 'UNCERTAIN', retryable: false, detailsCode: Number(body.code) || undefined,
        errorCode: String(body.code || 'INITIATION_UNCERTAIN'), errorMessage: definitive ? 'Initialisation refusée par CinetPay' : undefined
      }, 'ACCEPTED');
      return { transaction, paymentUrl: null, pending: !definitive, refused: definitive };
    }
    transaction = await safety.updateStatus(CinetpayTransaction, transaction, 'INITIATED', {
      cinetpayTransactionId: adapter.apiVersion === 'v1' ? data.transaction_id : undefined,
      paymentToken: data.payment_token || data.token, notifyToken: data.notify_token,
      paymentUrl: data.payment_url, verificationPending: false, initiationPhase: 'SUBMITTED', retryable: false,
      detailsCode: Number(body.code) || undefined, detailsStatus: data.details?.status
    }, 'ACCEPTED');
    return { transaction, paymentUrl: data.payment_url };
  } catch (error) {
    transaction = await safety.updateStatus(CinetpayTransaction, transaction, 'PENDING', {
      verificationPending: true, initiationPhase: 'UNCERTAIN', lastVerificationError: 'INITIATION_UNCERTAIN'
    }, 'ACCEPTED');
    console.warn('[cinetpay] initiation outcome uncertain', { code: error.code || 'PSP_ERROR', httpStatus: error.response?.status });
    return { transaction, paymentUrl: null, pending: true };
  }
}

async function checkTransactionStatus(transactionId) {
  const transaction = await CinetpayTransaction.findOne({ transactionId }).populate(['package', 'user']);
  if (!transaction) throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
  const adapter = getAdapter(getConfig(), transaction.currency, transaction.apiVersion);
  let response;
  try {
  if (adapter.apiVersion === 'legacy-v2') {
    response = await axios.post(`${adapter.apiUrl}/v2/payment/check`, {
      apikey: adapter.apiKey, site_id: adapter.siteId, transaction_id: transactionId
    }, requestOptions());
  } else {
    response = await callWithToken(transaction.currency, adapter, token => axios.get(
      `${adapter.apiUrl}/v1/payment/${encodeURIComponent(transactionId)}`,
      requestOptions({ headers: { Authorization: `Bearer ${token}` } })));
  }
  } catch (error) {
    const data = error.response?.data;
    if (!isVerifiedNotFound(data)) throw error;
    response = { data };
  }
  const body = response.data || {};
  if (adapter.apiVersion === 'v1' && isVerifiedNotFound(body) &&
      ['PREPARED', 'SUBMITTING', 'UNCERTAIN'].includes(transaction.initiationPhase) &&
      Date.now() - new Date(transaction.initiationClaimedAt || transaction.createdAt).getTime() > 2 * 60 * 1000) {
    // Authenticated provider JSON confirms this exact merchant ID is absent.
    // A deliberate retry may submit it again; never generate a replacement ID.
    return safety.prepareRetry(CinetpayTransaction, transaction, {
      initiationPhase: 'PREPARED', retryable: true, verificationPending: true,
      lastVerificationError: 'PAYMENT_NOT_SUBMITTED', lastCheckedAt: new Date()
    });
  }
  const data = adapter.apiVersion === 'legacy-v2' ? body.data || {} : body;
  // v2 code 00 is the successful response envelope; data.status is the
  // financial result. Error envelopes must never be interpreted as receipts.
  const validEnvelope = adapter.apiVersion === 'v1' || String(body.code) === '00';
  const status = validEnvelope ? mapStatus(data.status, data.code || body.code, transaction.createdAt) : 'PENDING';
  const patch = { detailsCode: Number(data.code || body.code) || undefined, detailsStatus: data.status,
    lastCheckedAt: new Date(), verificationPending: !validEnvelope, lastVerificationError: null };
  const recoveredUrl = verifiedCheckoutUrl(data.payment_url);
  if (recoveredUrl) patch.paymentUrl = recoveredUrl;
  // v1 may acknowledge a created checkout without returning its URL during
  // status retrieval. Only an explicit user action may replace that checkout.
  patch.canStartNewCheckout = adapter.apiVersion === 'v1' &&
    data.merchant_transaction_id === transactionId &&
    ['INITIATED', 'PENDING', 'WAITING_FOR_CUSTOMER', 'WAITING'].includes(String(data.status).toUpperCase()) &&
    !transaction.paymentUrl && !recoveredUrl &&
    Date.now() - new Date(transaction.initiationClaimedAt || transaction.createdAt).getTime() > 2 * 60 * 1000;
  if (status === 'ACCEPTED' && !receiptMatches(transaction, body, adapter.apiVersion)) {
    await safety.updateStatus(CinetpayTransaction, transaction, null, { ...patch,
      reconciliationMismatch: true, verificationPending: true, lastVerificationError: 'RECEIPT_MISMATCH' }, 'ACCEPTED');
    throw new CinetpayError('Le reçu de paiement doit être vérifié', 502);
  }
  patch.reconciliationMismatch = false;
  if (data.payment_method) patch.paymentMethod = data.payment_method;
  return safety.updateStatus(CinetpayTransaction, transaction, status, patch, 'ACCEPTED');
}

module.exports = { initiatePayment, checkTransactionStatus, getConfig, getAdapter, getAccessToken,
  detectCurrencyFromPhone, resolveCurrency, mapStatus, receiptMatches, isInvalidTokenError, CinetpayError };
