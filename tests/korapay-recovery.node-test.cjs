const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { AppError, ErrorCodes } = require('../src/utils/AppError');

function load(relative, mocks, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module, exports: module.exports, Buffer, Map, Date, process: { env },
    console: { log() {}, error() {} },
    require(key) { if (!(key in mocks)) throw new Error(`Unexpected dependency ${key}`); return mocks[key]; },
  }, { filename: relative });
  return module.exports;
}

function harness(overrides = {}) {
  const rows = new Map();
  const calls = { get: [], post: [], queries: [], writes: [], activations: 0 };
  const pkg = { _id: 'pkg', isActive: true, paymentMode: 'money', name: { fr: 'VIP' }, duration: 1,
    pricing: new Map([['NGN', 2500], ['KES', 200], ['GHS', 20], ['XOF', 1000], ['ZAR', 30]]) };
  const clone = value => value ? { ...value, save: async function() { rows.set(this.reference, { ...this }); },
    populate: async function() { return this; }, isSuccessful() { return this.status === 'SUCCESS'; } } : null;
  class Transaction {
    constructor(data) { Object.assign(this, clone({ _id: 'transaction', processed: false, ...data })); }
    static async findByReference(reference, userId) {
      calls.queries.push({ reference, userId });
      const row = [...rows.values()].find(item => [item.reference, item.transactionId, item.korapayReference].includes(reference));
      return row && (!userId || row.user === userId) ? clone(row) : null;
    }
    static findOneAndUpdate(query, update, options) {
      calls.writes.push({ query, update, options });
      const row = [...rows.values()].find(item => item._id === query._id);
      let result = null;
      if (row && (row.status !== 'SUCCESS' || !row.verifiedPaymentAt)) {
        Object.assign(row, update.$set); result = clone(row);
      }
      return { populate: async () => result };
    }
    static async updateOne(query, update) {
      const row = [...rows.values()].find(item => item._id === query._id);
      if (row) Object.assign(row, update.$set);
    }
  }
  const axios = {
    async post(...args) { calls.post.push(args); if (overrides.postError) throw overrides.postError;
      return { data: { status: true, data: { reference: args[1].reference, checkout_url: 'https://checkout.korapay.com/test-only' } } }; },
    async get(...args) { calls.get.push(args); if (overrides.getError) throw overrides.getError;
      if (overrides.get) return overrides.get(...args);
      return { data: { status: true, data: overrides.charge || { reference: 'ref', currency: 'NGN', amount: '2500', status: 'success' } } }; },
  };
  const env = { KORAPAY_SECRET_KEY: 'test-only-secret', APP_BASE_URL: 'https://api.example.invalid', ...overrides.env };
  const service = load('src/api/services/user/KorapayService.js', {
    axios, crypto, uuid: { v4: () => 'test-only-uuid' },
    '../../models/user/KorapayTransaction': Transaction,
    '../../models/common/Package': { findById: async () => overrides.pkg || pkg },
    '../common/mobileMoneySettlement': { capturePurchaseSnapshot: (p, currency, amount) => ({ amount, currency, duration: p.duration }) },
    '../../../utils/AppError': { AppError, ErrorCodes },
  }, env);
  const middleware = { async processTransactionUpdate(tx) {
    if (overrides.activationError) throw overrides.activationError;
    if (tx.status !== 'SUCCESS') return null;
    if (!tx.processed) { calls.activations++; tx.processed = true; await tx.save(); }
    return { _id: 'subscription', status: 'active' };
  } };
  const controller = load('src/api/controllers/user/korapayController.js', {
    '../../services/user/KorapayService': service,
    '../../models/user/KorapayTransaction': Transaction,
    '../../middlewares/payment/paymentMiddleware': middleware,
    '../../services/user/subscriptionService': { getActiveSubscriptions: async () => [] },
    '../../../utils/AppError': { AppError, ErrorCodes },
    '../../../utils/catchAsync': fn => fn,
  }, env);
  function seed(extra = {}) {
    const row = { _id: 'transaction', reference: 'ref', transactionId: 'ref', user: 'owner', package: 'pkg',
      amount: 2500, amountExpected: 2500, currency: 'NGN', status: 'PENDING', processed: false, ...extra };
    rows.set(row.reference, row); return row;
  }
  return { service, controller, calls, rows, seed, pkg, Transaction };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
}
function signed(payload) {
  return { body: payload, headers: { 'x-korapay-signature': crypto.createHmac('sha256', 'test-only-secret')
    .update(JSON.stringify(payload.data)).digest('hex') } };
}

test('Kora sends the WinTips webhook plus redirect and freezes purchase terms for each supported configured currency', async () => {
  const h = harness();
  for (const currency of ['NGN', 'KES', 'GHS', 'XOF', 'ZAR']) {
    const result = await h.service.initiatePayment('owner', 'pkg', currency, 'Test User', 'test@example.invalid');
    const [, payload, options] = h.calls.post.at(-1);
    assert.equal(payload.notification_url, 'https://api.example.invalid/api/payments/korapay/webhook');
    assert.equal(payload.redirect_url, 'https://api.example.invalid/api/payments/korapay/callback');
    assert.equal(payload.amount, h.pkg.pricing.get(currency));
    assert.equal(result.transaction.purchaseSnapshot.currency, currency);
    assert.equal(options.timeout, 15000);
  }
});

test('retired or ad-funded package cannot start a money charge', async () => {
  for (const patch of [{ isActive: false }, { paymentMode: 'ads' }]) {
    const h = harness(); Object.assign(h.pkg, patch);
    await assert.rejects(h.service.initiatePayment('owner', 'pkg', 'NGN', 'Test', 'test@example.invalid'));
    assert.equal(h.calls.post.length, 0);
  }
});

test('initialization timeout preserves the reference for reconciliation and does not issue a second charge', async () => {
  const h = harness({ postError: new Error('private provider headers must not leak') });
  await assert.rejects(h.service.initiatePayment('owner', 'pkg', 'NGN', 'Test', 'test@example.invalid'), e => e.statusCode === 503 && !e.message.includes('private'));
  assert.equal(h.rows.size, 1); assert.equal(h.calls.post.length, 1);
});

test('foreign user status fails before contacting the provider or mutating transaction', async () => {
  const h = harness(); h.seed();
  await assert.rejects(h.service.checkTransactionStatus('ref', { userId: 'foreign' }), e => e.statusCode === 404);
  assert.equal(h.calls.get.length, 0); assert.equal(h.calls.writes.length, 0);
});

test('authenticated verification validates exact reference, currency and actual paid amount', async () => {
  const h = harness(); h.seed();
  const tx = await h.service.checkTransactionStatus('ref', { userId: 'owner' });
  assert.equal(tx.status, 'SUCCESS'); assert.ok(tx.verifiedPaymentAt);
  assert.equal(tx.verifiedAmount, 2500); assert.equal(tx.verifiedCurrency, 'NGN');
  assert.equal(h.calls.get[0][1].timeout, 15000);
  assert.match(h.calls.get[0][0], /\/charges\/ref$/);
});

test('underpayment, missing amount, wrong currency or unrelated reference never activates', async () => {
  for (const patch of [{ amount: 2400 }, { amount: undefined, amount_expected: 2500 },
    { amount: 'NaN' }, { amount: null }, { amount: '' }, { currency: 'KES' }, { reference: 'foreign' }]) {
    const h = harness({ charge: { reference: 'ref', currency: 'NGN', amount: 2500, status: 'success', ...patch } }); h.seed();
    await assert.rejects(h.service.checkTransactionStatus('ref'), e => e.statusCode === 422);
    assert.equal(h.rows.get('ref').status, 'PENDING'); assert.equal(h.calls.writes.length, 0);
  }
});

test('provider-generated charge reference is accepted only when its merchant payment_reference matches', async () => {
  const h = harness({ charge: { reference: 'provider-reference', payment_reference: 'ref', currency: 'NGN', amount: '2500.00', status: 'successful' } });
  h.seed(); assert.equal((await h.service.checkTransactionStatus('ref')).status, 'SUCCESS');
});

test('a verified late success revives an expired/failed transaction and unknown channel labels do not block settlement', async () => {
  for (const status of ['EXPIRED', 'FAILED']) {
    const h = harness({ charge: { reference: 'ref', currency: 'NGN', amount: '2500', status: 'success', payment_method: 'new_provider_channel' } });
    h.seed({ status, processed: status === 'FAILED' });
    const tx = await h.service.checkTransactionStatus('ref');
    assert.equal(tx.status, 'SUCCESS'); assert.equal(tx.processed, false); assert.ok(tx.verifiedPaymentAt);
    assert.equal(tx.paymentMethod, undefined);
  }
});

test('temporary verification error does not set failed/expired and strips provider details', async () => {
  const h = harness({ getError: new Error('private token') }); h.seed();
  await assert.rejects(h.service.checkTransactionStatus('ref'), e => e.statusCode === 503 && !e.message.includes('private'));
  assert.equal(h.rows.get('ref').status, 'PENDING');
});

test('verified success duplicate remains available during provider outage without resetting processed', async () => {
  const h = harness({ getError: new Error('offline') }); h.seed({ status: 'SUCCESS', verifiedPaymentAt: new Date(), processed: true });
  const tx = await h.service.checkTransactionStatus('ref');
  assert.equal(tx.processed, true); assert.equal(h.calls.get.length, 0); assert.equal(h.calls.writes.length, 0);
});

test('a late pending response cannot downgrade a concurrently committed verified success', async () => {
  let finish;
  const h = harness({ get: () => new Promise(resolve => { finish = resolve; }) }); h.seed();
  const pending = h.service.checkTransactionStatus('ref');
  await new Promise(resolve => setImmediate(resolve));
  h.rows.set('ref', { ...h.rows.get('ref'), status: 'SUCCESS', processed: true, verifiedPaymentAt: new Date() });
  finish({ data: { status: true, data: { status: 'pending' } } });
  const tx = await pending; assert.equal(tx.status, 'SUCCESS'); assert.equal(tx.processed, true);
});

test('HMAC covers the documented data object with strict hex validation', () => {
  const h = harness(); const payload = { event: 'charge.success', data: { reference: 'ref', amount: 2500 } };
  const req = signed(payload);
  assert.equal(h.service.verifyWebhookSignature(req.headers['x-korapay-signature'], payload.data), true);
  assert.equal(h.service.verifyWebhookSignature(req.headers['x-korapay-signature'], { ...payload.data, amount: 1 }), false);
  for (const bad of [undefined, '', 'x'.repeat(64), 'ab', ['ab']]) assert.equal(h.service.verifyWebhookSignature(bad, payload.data), false);
});

test('unsigned webhook cannot query or activate even with a success payload', async () => {
  const h = harness(); h.seed(); const res = response();
  await h.controller.webhook({ headers: {}, body: { event: 'charge.success', data: { reference: 'ref' } } }, res);
  assert.equal(res.statusCode, 401); assert.equal(h.calls.get.length, 0); assert.equal(h.calls.activations, 0);
});

test('signed success webhook calls provider and duplicate webhook/poll returns same activated subscription', async () => {
  const h = harness(); h.seed(); const req = signed({ event: 'charge.success', data: { reference: 'ref' } });
  for (let i = 0; i < 2; i++) { const res = response(); await h.controller.webhook(req, res); assert.equal(res.statusCode, 200); }
  const status = response(); await h.controller.checkStatus({ params: { reference: 'ref' }, user: { _id: 'owner' } }, status);
  assert.equal(status.body.data.transaction.subscriptionActivated, true);
  assert.equal(status.body.data.subscription.id, 'subscription');
  assert.equal(h.calls.activations, 1); assert.equal(h.calls.get.length, 1);
});

test('signed event type cannot fake success when the authenticated provider still says pending', async () => {
  const h = harness({ charge: { reference: 'ref', currency: 'NGN', amount: 2500, status: 'pending' } }); h.seed();
  const res = response(); await h.controller.webhook(signed({ event: 'charge.success', data: { reference: 'ref' } }), res);
  assert.equal(res.statusCode, 503); assert.equal(h.calls.activations, 0);
});

test('provider or activation outage yields retryable webhook 503, never a false acknowledgement', async () => {
  for (const options of [{ getError: new Error('offline') }, { activationError: new Error('database offline') }]) {
    const h = harness(options); h.seed(); const res = response();
    await h.controller.webhook(signed({ event: 'charge.success', data: { reference: 'ref' } }), res);
    assert.equal(res.statusCode, 503); assert.equal(h.rows.get('ref').processed, false);
  }
});

test('refund or unknown signed reference is acknowledged without granting rights', async () => {
  const h = harness(); h.seed();
  for (const payload of [{ event: 'refund.success', data: { reference: 'ref' } }, { event: 'charge.success', data: { reference: 'unknown' } }]) {
    const res = response(); await h.controller.webhook(signed(payload), res); assert.equal(res.statusCode, 200);
  }
  assert.equal(h.calls.get.length, 0); assert.equal(h.calls.activations, 0);
});

test('browser query status is ignored and only authenticated provider success activates', async () => {
  const h = harness({ charge: { reference: 'ref', status: 'pending' } }); h.seed(); const res = response();
  await h.controller.callback({ query: { reference: 'ref', status: 'success' } }, res);
  assert.equal(h.calls.activations, 0); assert.match(res.body, /Payment Pending/);
});

test('reconciliation includes paid unprocessed and previously expired payments without fabricating a local failure', async () => {
  const queries = [], verified = [], activated = [];
  const rows = [
    { reference: 'paid-not-active', status: 'SUCCESS', processed: false, createdAt: new Date(Date.now() - 10 * 86400000), save: async () => {} },
    { reference: 'late-provider', status: 'EXPIRED', processed: false, createdAt: new Date(Date.now() - 2 * 86400000), save: async () => {} },
  ];
  const service = load('src/api/services/user/korapayVerificationService.js', {
    '../../models/user/KorapayTransaction': { find: async query => { queries.push(query); return rows; } },
    './KorapayService': { checkTransactionStatus: async reference => { verified.push(reference); return { reference, status: 'SUCCESS' }; } },
    '../../middlewares/payment/paymentMiddleware': { processTransactionUpdate: async tx => { activated.push(tx.reference); return {}; } },
  });
  const summary = await service.verifyAllPendingTransactions();
  assert.equal(summary.succeeded, 2); assert.equal(verified.length, 2); assert.equal(activated.length, 2);
  assert.equal(queries[0].$or[0].status, 'SUCCESS'); assert.ok(queries[0].$or[1].status.$in.includes('EXPIRED'));
  assert.equal(await service.expireOldPending(), 0);
  assert.equal(service.shouldCheckNow({ ...rows[0], lastCheckedAt: undefined }), true);
  assert.equal(service.recoveryQuery('owner').user, 'owner');
});

test('webhook is public while manual status and initialization remain protected', () => {
  const handlers = [];
  const controller = { callback() {}, webhook() {}, initiatePayment() {}, checkStatus() {} };
  const protect = () => {};
  const router = { get: (route, action) => handlers.push({ method: 'GET', route, action }),
    post: (route, action) => handlers.push({ method: 'POST', route, action }), use: action => handlers.push({ action }) };
  load('src/api/routes/user/korapayRoutes.js', { express: { Router: () => router },
    '../../controllers/user/korapayController': controller, '../../middlewares/user/userAuth': { protect } });
  const publicWebhook = handlers.findIndex(item => item.route === '/webhook');
  const auth = handlers.findIndex(item => item.action === protect);
  assert.ok(publicWebhook >= 0 && publicWebhook < auth);
  assert.ok(handlers.findIndex(item => item.route === '/status/:reference') > auth);
});
