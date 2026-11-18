/** Hosted checkout, authenticated charge verification and signed Kora webhooks. */
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const KorapayTransaction = require('../../models/user/KorapayTransaction');
const Package = require('../../models/common/Package');
const { capturePurchaseSnapshot } = require('../common/mobileMoneySettlement');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

const REQUEST_TIMEOUT_MS = 15000;

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
    apiUrl: (process.env.KORAPAY_API_URL || 'https://api.korapay.com/merchant').replace(/\/+$/, ''),
    publicKey: process.env.KORAPAY_PUBLIC_KEY,
    secretKey: process.env.KORAPAY_SECRET_KEY,
    encryptionKey: process.env.KORAPAY_ENCRYPTION_KEY,
    enabled: !!process.env.KORAPAY_SECRET_KEY,
  };
}

function validateConfig(config) {
  if (!config.enabled || !config.secretKey) {
    throw new KorapayError('KoraPay non configuré', 503);
  }
  if (!config.apiUrl) throw new KorapayError('URL API KoraPay non configurée', 503);
}

function generateUrls() {
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new KorapayError('URL de retour KoraPay non configurée', 503);
  return {
    notification_url: `${base}/api/payments/korapay/webhook`,
    redirect_url: `${base}/api/payments/korapay/callback`,
  };
}

function createHeaders(config) {
  return { Authorization: `Bearer ${config.secretKey}`, 'Content-Type': 'application/json' };
}

// The signature covers ONLY the data object, as specified by Kora. Never trust
// event/status from the browser redirect, or activate from an unsigned body.
function verifyWebhookSignature(signature, data, secretKey = getConfig().secretKey) {
  if (typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature) ||
      !data || typeof data !== 'object' || Array.isArray(data) || !secretKey) return false;
  const expected = crypto.createHmac('sha256', secretKey).update(JSON.stringify(data)).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function mapKorapayStatus(status) {
  return ({ success: 'SUCCESS', successful: 'SUCCESS', processing: 'PROCESSING',
    failed: 'FAILED', pending: 'PENDING', cancelled: 'CANCELLED', canceled: 'CANCELLED' })[
    typeof status === 'string' ? status.toLowerCase() : ''
  ] || 'PENDING';
}

function verifiedCharge(transaction, data) {
  const known = [transaction.reference, transaction.transactionId, transaction.korapayReference].filter(Boolean);
  if (![data.reference, data.payment_reference].some(ref => typeof ref === 'string' && known.includes(ref))) {
    throw new KorapayError('Référence de paiement KoraPay incohérente', 422);
  }
  if (typeof data.currency !== 'string' || data.currency.toUpperCase() !== transaction.currency) {
    throw new KorapayError('Devise de paiement KoraPay incohérente', 422);
  }
  // amount_expected alone is not proof of payment: successful bank transfers
  // may be underpaid. Fees/amount_charged are not substituted for amount.
  const raw = data.amount;
  const amount = typeof raw === 'number' || (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw)) ? Number(raw) : NaN;
  const expected = Number(transaction.amountExpected ?? transaction.amount);
  if (!Number.isFinite(amount) || !Number.isFinite(expected) || expected <= 0 || amount + 0.000001 < expected) {
    throw new KorapayError('Montant de paiement KoraPay insuffisant ou invalide', 422);
  }
  return { amount, currency: data.currency.toUpperCase() };
}

async function initiatePayment(userId, packageId, currency, customerName, customerEmail, customerPhone = null, merchantBearsCost = false) {
  const config = getConfig();
  validateConfig(config);
  const packageDoc = await Package.findById(packageId);
  if (!packageDoc || !packageDoc.isActive || packageDoc.paymentMode === 'ads') {
    throw new AppError('Package non disponible', 404, ErrorCodes.PACKAGE_NOT_AVAILABLE);
  }
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const amount = packageDoc.pricing instanceof Map ? packageDoc.pricing.get(normalizedCurrency) : packageDoc.pricing?.[normalizedCurrency];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError(`Prix ${normalizedCurrency} non disponible pour ce package`, 400, ErrorCodes.VALIDATION_ERROR);
  }
  const transactionId = `KPY_TXN_${Date.now()}_${uuidv4().substring(0, 8)}`;
  const { notification_url, redirect_url } = generateUrls();
  const transaction = new KorapayTransaction({
    transactionId, reference: transactionId, user: userId, package: packageId,
    amount, currency: normalizedCurrency, customerName, customerEmail, customerPhone,
    description: `${packageDoc.name?.fr || packageDoc.name?.en || 'Package'} - ${packageDoc.duration} jours`,
    amountExpected: amount, notificationUrl: notification_url, redirectUrl: redirect_url,
    purchaseSnapshot: capturePurchaseSnapshot(packageDoc, normalizedCurrency, amount),
    status: 'PENDING', merchantBearsCost,
  });
  await transaction.save();
  const payload = {
    reference: transactionId, amount, currency: normalizedCurrency, redirect_url, notification_url,
    customer: { name: customerName, email: customerEmail }, merchant_bears_cost: merchantBearsCost,
    metadata: { user_id: userId.toString(), package_id: packageId.toString(), transaction_id: transactionId },
  };
  if (customerPhone) payload.customer.phone = customerPhone;
  try {
    const response = await axios.post(`${config.apiUrl}/api/v1/charges/initialize`, payload,
      { headers: createHeaders(config), timeout: REQUEST_TIMEOUT_MS });
    const data = response.data?.data;
    if (response.data?.status !== true || !data || typeof data.checkout_url !== 'string' || !/^https:\/\//i.test(data.checkout_url)) {
      throw new KorapayError('Initialisation KoraPay non confirmée', 502);
    }
    transaction.korapayReference = data.reference || transaction.reference;
    transaction.checkoutUrl = data.checkout_url;
    await transaction.save();
    await transaction.populate(['package', 'user']);
    return { transaction, checkoutUrl: transaction.checkoutUrl };
  } catch (error) {
    // Keep the reference after a timeout: the provider may have accepted it.
    // Polling/webhook can still reconcile it; never issue an automatic re-charge.
    if (error instanceof KorapayError || error instanceof AppError) throw error;
    throw new KorapayError('Le service KoraPay est temporairement indisponible', 503);
  }
}

async function checkTransactionStatus(reference, { userId } = {}) {
  const transaction = await KorapayTransaction.findByReference(reference, userId);
  if (!transaction) throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
  // Durable verified success is terminal; a duplicate callback need not depend
  // on a later provider outage. Older successes without proof are re-queried.
  if (transaction.status === 'SUCCESS' && transaction.verifiedPaymentAt) return transaction;
  const config = getConfig();
  validateConfig(config);
  const verifyReference = transaction.reference || transaction.korapayReference || transaction.transactionId;
  let response;
  try {
    response = await axios.get(`${config.apiUrl}/api/v1/charges/${encodeURIComponent(verifyReference)}`,
      { headers: createHeaders(config), timeout: REQUEST_TIMEOUT_MS });
  } catch (error) {
    throw new KorapayError('Vérification KoraPay temporairement indisponible', 503);
  }
  if (response.data?.status !== true || !response.data?.data) {
    throw new KorapayError('Vérification KoraPay non confirmée', 503);
  }
  const paymentData = response.data.data;
  const status = mapKorapayStatus(paymentData.status);
  const updates = { status, responseMessage: status, lastCheckedAt: new Date() };
  if (status === 'SUCCESS') {
    const proof = verifiedCharge(transaction, paymentData);
    updates.verifiedPaymentAt = new Date();
    updates.verifiedAmount = proof.amount;
    updates.verifiedCurrency = proof.currency;
    updates.paymentDate = transaction.paymentDate || new Date();
    updates.processed = false;
  }
  // An additional provider channel must not invalidate a paid transaction just
  // because an older application enum does not yet list that display label.
  if (['card', 'bank_transfer', 'mobile_money', 'pay_with_bank', 'virtual_account'].includes(paymentData.payment_method)) {
    updates.paymentMethod = paymentData.payment_method;
  }
  for (const field of ['fee', 'vat']) if (Number.isFinite(Number(paymentData[field]))) updates[field] = Number(paymentData[field]);
  if (Number.isFinite(Number(paymentData.amount_charged))) updates.amountCharged = Number(paymentData.amount_charged);
  // A pending response racing a success must never undo that success. Likewise
  // a duplicate success must not reset an already processed transaction.
  const updated = await KorapayTransaction.findOneAndUpdate(
    { _id: transaction._id, $or: [{ status: { $ne: 'SUCCESS' } }, { verifiedPaymentAt: null }] },
    { $set: updates }, { new: true, runValidators: true }
  ).populate(['package', 'user']);
  return updated || KorapayTransaction.findByReference(reference, userId);
}

module.exports = { getConfig, validateConfig, generateUrls, initiatePayment,
  checkTransactionStatus, verifyWebhookSignature, verifiedCharge, mapKorapayStatus, KorapayError };
