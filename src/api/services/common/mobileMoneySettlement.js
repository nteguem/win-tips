'use strict';

// This module never calls a payment provider. Only the PSP-specific server-side
// verification code may populate verifiedPaymentAt/Amount/Currency.
const SETTLEMENT_MODELS = new Set(['KorapayTransaction', 'PawapayTransaction']);
const INDEX_NAME = 'mobile_money_settlement_unique';
const indexPromises = new WeakMap();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 409;
  throw error;
}

function reference(value) {
  return value && value._id ? value._id : value;
}

function currencyCode(value) {
  const currency = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_SETTLEMENT_CURRENCY');
  return currency;
}

function amountValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('INVALID_SETTLEMENT_AMOUNT');
  }
  return value;
}

function categoriesFor(value) {
  if (!Array.isArray(value)) fail('INVALID_PURCHASE_CATEGORIES');
  return [...new Set(value.map(item => {
    const id = String(reference(item) || '');
    if (!/^[a-f\d]{24}$/i.test(id)) fail('INVALID_PURCHASE_CATEGORY');
    return id.toLowerCase();
  }))];
}

function capturePurchaseSnapshot(packageDoc, currency, amount) {
  if (!packageDoc) fail('PURCHASE_PACKAGE_REQUIRED');
  const duration = Number(packageDoc.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail('INVALID_PURCHASE_DURATION');
  return {
    amount: amountValue(amount),
    currency: currencyCode(currency),
    duration,
    categories: categoriesFor(packageDoc.categories || [])
  };
}

function isSupportedTransaction(transaction) {
  return SETTLEMENT_MODELS.has(transaction?.constructor?.modelName);
}

function assertVerifiedPayment(transaction) {
  if (!isSupportedTransaction(transaction)) fail('UNSUPPORTED_SETTLEMENT_PROVIDER');
  if (transaction.status !== 'SUCCESS') fail('PAYMENT_NOT_SUCCESSFUL');
  const verifiedAt = new Date(transaction.verifiedPaymentAt || '');
  if (!Number.isFinite(verifiedAt.getTime())) fail('PAYMENT_NOT_SERVER_VERIFIED');
  const expected = amountValue(transaction.amount);
  const paid = amountValue(transaction.verifiedAmount);
  const currency = currencyCode(transaction.currency);
  if (currencyCode(transaction.verifiedCurrency) !== currency) fail('PAYMENT_CURRENCY_MISMATCH');
  if (paid < expected) fail('PAYMENT_AMOUNT_INSUFFICIENT');
  return { amount: expected, currency };
}

async function ensureSettlementIndex(Subscription) {
  const collection = Subscription.collection;
  let pending = indexPromises.get(collection);
  if (!pending) {
    pending = collection.createIndex({ mobileMoneySettlementKey: 1 }, {
      unique: true, sparse: true, name: INDEX_NAME
    }).catch(error => {
      indexPromises.delete(collection);
      throw error;
    });
    indexPromises.set(collection, pending);
  }
  await pending;
}

function createSettlementService({ Subscription, Package, now = () => new Date() }) {
  async function settleVerifiedPayment(transaction) {
    const verified = assertVerifiedPayment(transaction);
    const txId = reference(transaction._id);
    if (!/^[a-f\d]{24}$/i.test(String(txId || ''))) fail('INVALID_SETTLEMENT_TRANSACTION');
    // Cast references explicitly: collection queries bypass Mongoose middleware
    // that normally hides expired subscriptions, and also bypass query casting.
    const user = Subscription.schema.path('user').cast(reference(transaction.user));
    const packageId = Subscription.schema.path('package').cast(reference(transaction.package));
    if (!user || !packageId) fail('INVALID_SETTLEMENT_OWNER');
    const key = `${transaction.constructor.modelName}:${String(txId)}`;
    const identity = { user, package: packageId, paymentReference: String(txId) };
    await ensureSettlementIndex(Subscription);

    let row = await Subscription.collection.findOne({ mobileMoneySettlementKey: key });
    let created = false;
    if (!row) {
      // Recover a pre-migration grant, including an expired/cancelled one. A
      // replay must never renew a previously fulfilled purchase.
      const historical = await Subscription.collection.findOne({
        user, package: packageId, paymentReference: { $in: [String(txId), txId] },
        $or: [{ paymentProvider: 'MOBILE_MONEY' }, { paymentProvider: { $exists: false } }]
      });
      if (historical) {
        if (historical.mobileMoneySettlementKey && historical.mobileMoneySettlementKey !== key) {
          fail('SETTLEMENT_IDENTITY_CONFLICT');
        }
        try {
          await Subscription.collection.updateOne({ _id: historical._id }, {
            $set: { mobileMoneySettlementKey: key }
          });
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
        row = await Subscription.collection.findOne({ mobileMoneySettlementKey: key });
      } else {
        const packageDoc = transaction.purchaseSnapshot ? null : await Package.findById(packageId);
        const snapshot = transaction.purchaseSnapshot
          ? capturePurchaseSnapshot(transaction.purchaseSnapshot, transaction.purchaseSnapshot.currency,
            transaction.purchaseSnapshot.amount)
          : capturePurchaseSnapshot(packageDoc, verified.currency, verified.amount);
        if (snapshot.currency !== verified.currency || snapshot.amount !== verified.amount) {
          fail('PURCHASE_SNAPSHOT_PAYMENT_MISMATCH');
        }
        const startDate = new Date(now());
        const endDate = new Date(startDate.getTime() + snapshot.duration * 86400000);
        if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
          fail('INVALID_SETTLEMENT_DATES');
        }
        const candidate = new Subscription({
          ...identity,
          mobileMoneySettlementKey: key,
          categorySnapshot: snapshot.categories,
          startDate, endDate,
          pricing: { amount: snapshot.amount, currency: snapshot.currency },
          status: 'active', paymentProvider: 'MOBILE_MONEY', autoRenewing: false
        });
        await candidate.validate();
        try {
          const result = await Subscription.collection.updateOne({ mobileMoneySettlementKey: key }, {
            $setOnInsert: candidate.toObject({ depopulate: true })
          }, { upsert: true });
          created = result.upsertedCount === 1;
        } catch (error) {
          // A concurrent webhook/status/cron may win the same unique upsert.
          if (error.code !== 11000) throw error;
        }
        row = await Subscription.collection.findOne({ mobileMoneySettlementKey: key });
      }
    }
    if (!row || String(row.user) !== String(user) || String(row.package) !== String(packageId)
      || String(row.paymentReference) !== String(txId)) fail('SETTLEMENT_IDENTITY_CONFLICT');

    // A crash after inserting the grant is recoverable: the next invocation
    // reads that same grant before setting this acknowledgement again.
    const acknowledged = await transaction.constructor.updateOne({ _id: txId, status: 'SUCCESS' }, {
      $set: { processed: true }
    });
    if (acknowledged.matchedCount !== 1) fail('SETTLEMENT_TRANSACTION_ACKNOWLEDGEMENT_FAILED');
    transaction.processed = true;
    const subscription = Subscription.hydrate(row);
    subscription.$locals.mobileMoneySettlementCreated = created;
    return subscription;
  }
  return { settleVerifiedPayment };
}

let defaultService;
function settleVerifiedPayment(transaction) {
  if (!defaultService) defaultService = createSettlementService({
    Subscription: require('../../models/common/Subscription'),
    Package: require('../../models/common/Package')
  });
  return defaultService.settleVerifiedPayment(transaction);
}

module.exports = {
  capturePurchaseSnapshot, settleVerifiedPayment, isSupportedTransaction,
  createSettlementService
};
