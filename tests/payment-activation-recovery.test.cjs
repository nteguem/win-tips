const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const clone = value => value == null ? value : structuredClone(value);

function load(file, dependencies) {
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console: quiet, Date, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return module.exports;
}

function matches(document, query) {
  return Object.entries(query).every(([key, wanted]) => {
    if (key === '$or') return wanted.some(condition => matches(document, condition));
    if (key === '$and') return wanted.every(condition => matches(document, condition));
    const actual = document[key];
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      return Object.entries(wanted).every(([operator, value]) => {
        if (operator === '$exists') return (actual !== undefined) === value;
        if (operator === '$ne') return actual !== value;
        if (operator === '$in') return value.includes(actual);
        if (operator === '$gte') return new Date(actual) >= new Date(value);
        if (operator === '$lte') return new Date(actual) <= new Date(value);
        throw new Error(`Unsupported query operator ${operator}`);
      });
    }
    return actual === wanted || (wanted === null && actual === undefined);
  });
}

function fixture() {
  const state = { subscriptions: new Map(), transactions: new Map(), notifications: 0, failActivationWrite: false };
  const user = '111111111111111111111111';
  const packageId = '222222222222222222222222';
  const packageCurrent = { _id: packageId, name: { fr: 'VIP' }, description: {}, duration: 1,
    pricing: new Map([['XAF', 1000]]), categories: ['sports'], isActive: true };
  state.package = packageCurrent;
  const Subscription = {
    async findOne(query) { return clone([...state.subscriptions.values()].find(doc => matches(doc, query)) || null); },
    async create(values) { const document = { ...clone(values), _id: crypto.randomBytes(12).toString('hex') }; state.subscriptions.set(document._id, document); return clone(document); },
    async findOneAndUpdate(query, update, options) {
      // This operation intentionally has no await: it models the atomicity
      // of MongoDB's unique _id update under concurrent callback requests.
      let document = [...state.subscriptions.values()].find(doc => matches(doc, query));
      if (!document && options?.upsert) {
        document = { _id: query._id, status: 'active', ...clone(update.$setOnInsert) };
        state.subscriptions.set(document._id, document);
      }
      if (!document) return null;
      Object.assign(document, clone(update.$set || {}));
      return clone(document);
    }
  };
  class AppError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
  const service = load('src/api/services/user/subscriptionService.js', {
    '../../models/common/Subscription': Subscription,
    '../../models/common/Package': { findById: async () => state.package },
    '../../models/user/User': { findById: async id => id === user ? { _id: user } : null },
    '../../models/common/Category': {}, '../../models/user/GooglePlayTransaction': {},
    '../../../utils/AppError': { AppError, ErrorCodes: { NOT_FOUND: 'NOT_FOUND', VALIDATION_ERROR: 'VALIDATION_ERROR' } }
  });
  class Transaction {
    constructor(values) { Object.assign(this, clone(values)); }
    isSuccessful() { return ['SUCCESS', 'ACCEPTED'].includes(this.status); }
    async populate() { this.package = { _id: packageId, name: { fr: 'VIP' } }; return this; }
    static async findById(id) { const found = state.transactions.get(id); return found ? new Transaction(found) : null; }
    static async updateOne(query, update) {
      if (state.failActivationWrite && update.$set?.processed) { state.failActivationWrite = false; throw new Error('Simulated crash after subscription insert'); }
      const found = [...state.transactions.values()].find(doc => matches(doc, query));
      if (found) Object.assign(found, clone(update.$set || {}));
      return { modifiedCount: found ? 1 : 0 };
    }
    static async findOneAndUpdate(query, update) {
      const found = [...state.transactions.values()].find(doc => matches(doc, query));
      if (!found) return null;
      Object.assign(found, clone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$inc || {})) found[key] = (found[key] || 0) + value;
      return new Transaction(found);
    }
  }
  const middleware = load('src/api/middlewares/payment/paymentMiddleware.js', {
    '../../services/user/subscriptionService': service,
    '../../services/common/notificationService': { async sendToUsers() { state.notifications++; } },
    '../../models/common/Device': { findOne() { return { sort: async () => ({ playerId: 'test-device' }) }; } },
    '../../models/common/Subscription': Subscription
  });
  function addTransaction(values = {}) {
    const transaction = { _id: '333333333333333333333333', user, package: packageId,
      amount: 1000, currency: 'XAF', status: 'SUCCESS', processed: false,
      createdAt: new Date(), depositId: 'receipt', transactionId: 'receipt',
      paymentSnapshot: { packageId, packageName: { fr: 'VIP acheté' }, packageDuration: 1,
        durationUnit: 'days', packageCouponTypes: ['sports'], amount: 1000, currency: 'XAF' },
      ...values };
    state.transactions.set(transaction._id, clone(transaction));
    return new Transaction(transaction);
  }
  return { state, user, packageId, service, middleware, Transaction, Subscription, addTransaction };
}

test('20 concurrent confirmations produce one subscription and one success notification', async () => {
  const f = fixture(); const transaction = f.addTransaction();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.middleware.processTransactionUpdate(new f.Transaction(transaction))));
  assert.equal(f.state.subscriptions.size, 1);
  assert.equal(new Set(results.map(result => result._id)).size, 1);
  assert.equal(f.state.notifications, 1);
  assert.equal(f.state.transactions.get(transaction._id).processed, true);
  assert.equal(f.state.transactions.get(transaction._id).subscriptionId, results[0]._id);
});

test('a crash between entitlement insertion and processed flag is repaired without extending access', async () => {
  const f = fixture(); const transaction = f.addTransaction(); f.state.failActivationWrite = true;
  await assert.rejects(f.middleware.processTransactionUpdate(transaction), /Simulated crash/);
  assert.equal(f.state.subscriptions.size, 1);
  assert.equal(f.state.transactions.get(transaction._id).processed, false);
  const originalEnd = [...f.state.subscriptions.values()][0].endDate;
  const recovered = await f.middleware.processTransactionUpdate(transaction);
  assert.equal(f.state.subscriptions.size, 1);
  assert.equal(+recovered.endDate, +originalEnd);
  assert.equal(f.state.transactions.get(transaction._id).processed, true);
});

test('failure never marks access processed; authenticated late success also repairs legacy processed failures', async () => {
  const f = fixture(); const transaction = f.addTransaction({ status: 'REFUSED' });
  await f.middleware.processTransactionUpdate(transaction);
  assert.equal(f.state.transactions.get(transaction._id).processed, false);
  Object.assign(f.state.transactions.get(transaction._id), { status: 'ACCEPTED', processed: true });
  await f.middleware.processTransactionUpdate(transaction);
  assert.equal(f.state.subscriptions.size, 1);
  assert.ok(f.state.transactions.get(transaction._id).subscriptionId);
});

test('settlement uses purchased duration, price and categories after package disabled and changed', async () => {
  const f = fixture(); const transaction = f.addTransaction();
  Object.assign(f.state.package, { isActive: false, duration: 30, categories: ['changed'] });
  f.state.package.pricing.set('XAF', 9000);
  const subscription = await f.middleware.processTransactionUpdate(transaction);
  assert.equal(subscription.pricing.amount, 1000);
  assert.equal(+subscription.endDate - +subscription.startDate, 24 * 60 * 60 * 1000);
  f.service.getActiveSubscriptions = async () => [{ ...subscription, package: null }];
  assert.equal(await f.service.hasAccessToCategory(f.user, 'sports'), true);
  assert.equal(await f.service.hasAccessToCategory(f.user, 'changed'), false);
  const info = await f.service.getUserSubscriptionInfo(f.user);
  assert.equal(info.hasActiveSubscription, true);
  assert.equal(info.activePackages[0].name.fr, 'VIP acheté');
});

test('valid purchase snapshot still activates if the package was removed after checkout', async () => {
  const f = fixture(); const transaction = f.addTransaction(); f.state.package = null;
  assert.ok((await f.middleware.processTransactionUpdate(transaction))._id);
});

test('invalid snapshot amount, currency, identity or duration is never activated', async () => {
  for (const patch of [{ amount: 1 }, { currency: 'XOF' }, { packageId: 'different' }, { packageDuration: 0 }, { durationUnit: 'months' }]) {
    const f = fixture(); const transaction = f.addTransaction();
    Object.assign(f.state.transactions.get(transaction._id).paymentSnapshot, patch);
    await assert.rejects(f.middleware.processTransactionUpdate(transaction));
    assert.equal(f.state.subscriptions.size, 0);
  }
});

test('an existing expired legacy entitlement is reused and is never renewed by receipt replay', async () => {
  const f = fixture(); const transaction = f.addTransaction();
  const existing = { _id: '444444444444444444444444', user: f.user, package: f.packageId,
    paymentReference: transaction._id, paymentProvider: 'MOBILE_MONEY', status: 'expired', endDate: new Date(0) };
  f.state.subscriptions.set(existing._id, clone(existing));
  const result = await f.middleware.processTransactionUpdate(transaction);
  assert.equal(result._id, existing._id); assert.equal(+result.endDate, 0);
  assert.equal(f.state.subscriptions.size, 1);
});

test('a reused payment reference owned by a different account does not deliver access', async () => {
  const f = fixture(); const transaction = f.addTransaction();
  f.state.subscriptions.set('other', { _id: 'other', user: 'different', package: f.packageId,
    paymentReference: transaction._id, paymentProvider: 'MOBILE_MONEY' });
  await assert.rejects(f.middleware.processTransactionUpdate(transaction), /incohérente/);
  assert.equal(f.state.transactions.get(transaction._id).processed, false);
});

test('a stale failure document cannot override a newer persisted success', async () => {
  const f = fixture(); const stale = f.addTransaction({ status: 'FAILED' });
  f.state.transactions.get(stale._id).status = 'SUCCESS';
  await f.middleware.processTransactionUpdate(stale);
  assert.equal(f.state.notifications, 1);
  assert.equal(f.state.subscriptions.size, 1);
  assert.equal(stale.status, 'SUCCESS');
});

test('receipt mismatches are quarantined even if a malformed stored status says successful', async () => {
  const f = fixture(); const transaction = f.addTransaction({ reconciliationMismatch: true });
  assert.equal(await f.middleware.processTransactionUpdate(transaction), null);
  assert.equal(f.state.subscriptions.size, 0);
});

test('legacy monetary providers without a snapshot can settle a disabled package', async () => {
  const f = fixture(); const transaction = f.addTransaction({ paymentSnapshot: undefined });
  f.state.package.isActive = false;
  const subscription = await f.middleware.processTransactionUpdate(transaction);
  assert.equal(subscription.pricing.amount, 1000);
  assert.equal(subscription.paymentProvider, 'MOBILE_MONEY');
});

test('normal direct subscription creation still rejects unavailable packages', async () => {
  const f = fixture(); f.state.package.isActive = false;
  await assert.rejects(f.service.createSubscription(f.user, f.packageId, 'XAF'), /non disponible/);
});

test('equal transaction IDs in different PSP collections cannot share an entitlement', async () => {
  const f = fixture(); const transaction = f.addTransaction();
  const options = { confirmedPayment: true, amount: transaction.amount, paymentSnapshot: transaction.paymentSnapshot };
  const first = await f.service.createSubscription(f.user, f.packageId, 'XAF', transaction._id, { ...options, providerKey: 'PawapayTransaction' });
  const second = await f.service.createSubscription(f.user, f.packageId, 'XAF', transaction._id, { ...options, providerKey: 'CinetpayTransaction' });
  assert.notEqual(first._id, second._id);
  assert.equal(f.state.subscriptions.size, 2);
});

test('notification persistence errors do not report an already activated payment as failed', async () => {
  const f = fixture(); const transaction = f.addTransaction();
  const original = f.Subscription.findOneAndUpdate;
  f.Subscription.findOneAndUpdate = async (query, ...args) => {
    if (query.paymentNotificationClaimedAt) throw new Error('Notification claim unavailable');
    return original(query, ...args);
  };
  const subscription = await f.middleware.processTransactionUpdate(transaction);
  assert.ok(subscription._id);
  assert.equal(f.state.transactions.get(transaction._id).processed, true);
  assert.equal(f.state.transactions.get(transaction._id).activationError, null);
});

test('recovery includes recent failed and settled-unprocessed receipts, isolates PSP errors and never charges', async () => {
  const f = fixture();
  f.addTransaction({ _id: 'success', status: 'SUCCESS' });
  f.addTransaction({ _id: 'late', status: 'FAILED', processed: true, createdAt: new Date(Date.now() - 2 * 86400000) });
  f.addTransaction({ _id: 'error', status: 'PENDING' });
  f.addTransaction({ _id: 'historical', status: 'PENDING', createdAt: new Date(Date.now() - 8 * 86400000) });
  f.addTransaction({ _id: 'mismatch', status: 'SUCCESS', reconciliationMismatch: true });
  let calls = 0;
  f.Transaction.find = query => ({ sort() { return { limit: async count => [...f.state.transactions.values()].filter(doc => matches(doc, query)).slice(0, count).map(doc => new f.Transaction(doc)) }; } });
  const recoveryModule = load('src/api/services/user/paymentVerificationRecovery.js', {});
  const recovery = recoveryModule.createRecovery({ Model: f.Transaction, referenceField: '_id', successStatus: 'SUCCESS', label: 'Test',
    service: { async checkTransactionStatus(id) { calls++; if (id === 'error') throw new Error('Provider unavailable'); f.state.transactions.get(id).status = 'SUCCESS'; return f.Transaction.findById(id); } },
    paymentMiddleware: f.middleware });
  const scan = await recovery.verifyAllPendingTransactions();
  assert.equal(scan.scanned, 4); assert.equal(scan.checked, 4); assert.equal(scan.succeeded, 2);
  assert.equal(calls, 3); // A quarantined success requires a fresh PSP receipt.
  assert.equal(f.state.subscriptions.size, 2);
  assert.equal(f.state.transactions.get('historical').status, 'PENDING');
  const second = await recovery.verifyAllPendingTransactions();
  assert.equal(second.checked, 0); assert.equal(calls, 3);
  assert.equal(await recovery.expireOldPending(), 0);
});

test('concurrent recovery scans and /me obey a persisted provider-query lease', async () => {
  const f = fixture(); f.addTransaction({ status: 'PENDING' });
  f.Transaction.find = query => ({ sort() { return { limit: async () => [...f.state.transactions.values()].filter(doc => matches(doc, query)).map(doc => new f.Transaction(doc)) }; } });
  const { createRecovery } = load('src/api/services/user/paymentVerificationRecovery.js', {});
  let calls = 0;
  const recovery = createRecovery({ Model: f.Transaction, referenceField: 'depositId', successStatus: 'SUCCESS', label: 'Test', paymentMiddleware: f.middleware,
    service: { async checkTransactionStatus() { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return new f.Transaction([...f.state.transactions.values()][0]); } } });
  await Promise.all([recovery.verifyAllPendingTransactions(), recovery.verifyAllPendingTransactions(), recovery.verifyUserPendingTransactions(f.user)]);
  assert.equal(calls, 1);
});

test('a settled payment with failed activation retries in one minute regardless of purchase age', async () => {
  const f = fixture(); const transaction = f.addTransaction({ createdAt: new Date(Date.now() - 2 * 86400000) });
  f.Transaction.find = query => ({ sort() { return { limit: async () => [...f.state.transactions.values()].filter(doc => matches(doc, query)).map(doc => new f.Transaction(doc)) }; } });
  const { createRecovery } = load('src/api/services/user/paymentVerificationRecovery.js', {});
  const recovery = createRecovery({ Model: f.Transaction, referenceField: 'depositId', successStatus: 'SUCCESS', label: 'Test',
    service: { async checkTransactionStatus() { throw new Error('A settled receipt must not require network for activation'); } },
    paymentMiddleware: { async processTransactionUpdate() { throw new Error('Temporary entitlement store error'); } } });
  const start = Date.now();
  const scan = await recovery.verifyAllPendingTransactions();
  assert.equal(scan.succeeded, 0);
  const delay = +f.state.transactions.get(transaction._id).nextCheckAt - start;
  assert.ok(delay >= 60000 && delay < 65000);
});

test('recovery repairs a legacy failure flag left processed before a late success activation', async () => {
  const f = fixture(); f.addTransaction({ status: 'SUCCESS', processed: true });
  f.Transaction.find = query => ({ sort() { return { limit: async () => [...f.state.transactions.values()].filter(doc => matches(doc, query)).map(doc => new f.Transaction(doc)) }; } });
  const { createRecovery } = load('src/api/services/user/paymentVerificationRecovery.js', {});
  const recovery = createRecovery({ Model: f.Transaction, referenceField: 'depositId', successStatus: 'SUCCESS', label: 'Test',
    service: { async checkTransactionStatus() { throw new Error('Already settled'); } }, paymentMiddleware: f.middleware });
  assert.equal((await recovery.verifyAllPendingTransactions()).succeeded, 1);
  assert.equal(f.state.subscriptions.size, 1);
});

test('/me returns within its shared recovery budget while a delayed receipt still activates afterward', { timeout: 3000 }, async () => {
  const f = fixture(); const transaction = f.addTransaction({ status: 'PENDING' });
  let releaseReceipt;
  const receiptGate = new Promise(resolve => { releaseReceipt = resolve; });
  let selectedLimit;
  f.Transaction.find = query => ({ sort() { return { limit: async count => {
    selectedLimit = count;
    return [...f.state.transactions.values()].filter(doc => matches(doc, query)).slice(0, count).map(doc => new f.Transaction(doc));
  } }; } });
  const { createRecovery, waitForUserRecovery } = load('src/api/services/user/paymentVerificationRecovery.js', {});
  const recovery = createRecovery({ Model: f.Transaction, referenceField: 'depositId', successStatus: 'SUCCESS', label: 'Test', paymentMiddleware: f.middleware,
    service: { async checkTransactionStatus() {
      await receiptGate;
      f.state.transactions.get(transaction._id).status = 'SUCCESS';
      return f.Transaction.findById(transaction._id);
    } } });
  let backgroundOperation;
  let invoked = 0;
  const emptyRecovery = { async verifyUserPendingTransactions() { invoked++; return []; } };
  f.service.getUserSubscriptionInfo = async () => ({ hasActiveSubscription: f.state.subscriptions.size > 0, activePackages: [] });
  const controller = load('src/api/controllers/user/authController.js', {
    '../../models/user/User': { async findById() { return { _id: f.user }; } },
    '../../services/common/authService': {}, '../../services/common/googleAuthService': {},
    '../../services/user/subscriptionService': f.service,
    '../../services/user/smobilpayVerificationService': emptyRecovery,
    '../../services/user/korapayVerificationService': emptyRecovery,
    '../../services/user/pawapayVerificationService': { verifyUserPendingTransactions(userId) {
      invoked++; backgroundOperation = recovery.verifyUserPendingTransactions(userId); return backgroundOperation;
    } },
    '../../services/user/cinetpayVerificationService': { async verifyUserPendingTransactions() { invoked++; throw new Error('Temporary provider outage'); } },
    '../../services/user/paymentVerificationRecovery': { waitForUserRecovery: operations => waitForUserRecovery(operations, 20) },
    '../../services/common/deviceService': {}, '../../../utils/AppError': {}, '../../../utils/catchAsync': handler => handler
  });
  let status, body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  const started = Date.now();
  await controller.getMe({ user: { _id: f.user } }, response);
  assert.ok(Date.now() - started < 1500, 'The session endpoint waited for the delayed provider');
  assert.equal(status, 200); assert.equal(body.success, true);
  assert.equal(body.data.hasActiveSubscription, false);
  assert.equal(invoked, 4); assert.equal(selectedLimit, 3);
  assert.equal(f.state.subscriptions.size, 0);
  releaseReceipt();
  await backgroundOperation;
  assert.equal(f.state.subscriptions.size, 1);
  assert.equal(f.state.transactions.get(transaction._id).processed, true);
});

test('recovery deadline clears its timer on early completion and handles a rejection after the deadline', { timeout: 2000 }, async () => {
  const { waitForUserRecovery } = load('src/api/services/user/paymentVerificationRecovery.js', {});
  const ready = await waitForUserRecovery([Promise.resolve('ready'), Promise.reject(new Error('Provider offline'))], 1000);
  assert.equal(ready.completed, true);
  assert.equal(ready.results[0].status, 'fulfilled');
  assert.equal(ready.results[1].status, 'rejected');
  let rejectLate;
  const delayedFailure = new Promise((resolve, reject) => { rejectLate = reject; });
  const deadline = await waitForUserRecovery([delayedFailure], 10);
  assert.equal(deadline.completed, false);
  // allSettled remains attached after Promise.race returns, so this does not
  // produce an unhandled rejection or change the already returned HTTP result.
  rejectLate(new Error('Provider timed out after response'));
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('user recovery selects only three recent due purchases while cron retains its larger batch', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.addTransaction({ _id: `pending-${i}`, status: 'PENDING', createdAt: new Date(Date.now() - i * 1000) });
  f.addTransaction({ _id: 'leased', status: 'PENDING', nextCheckAt: new Date(Date.now() + 60000) });
  const limits = [];
  f.Transaction.find = query => ({ sort(order) { return { limit: async count => {
    limits.push(count);
    return [...f.state.transactions.values()].filter(doc => matches(doc, query))
      .sort((a, b) => order.createdAt < 0 ? +b.createdAt - +a.createdAt : +a.createdAt - +b.createdAt)
      .slice(0, count).map(doc => new f.Transaction(doc));
  } }; } });
  const { createRecovery } = load('src/api/services/user/paymentVerificationRecovery.js', {});
  const checked = [];
  const recovery = createRecovery({ Model: f.Transaction, referenceField: '_id', successStatus: 'SUCCESS', label: 'Test', paymentMiddleware: f.middleware,
    service: { async checkTransactionStatus(id) { checked.push(id); return f.Transaction.findById(id); } } });
  await recovery.verifyUserPendingTransactions(f.user);
  assert.deepEqual(checked, ['pending-0', 'pending-1', 'pending-2']);
  await recovery.verifyAllPendingTransactions();
  assert.deepEqual(limits, [3, 300]);
  assert.equal(checked.length, 6);
  assert.equal(checked.includes('leased'), false);
});
