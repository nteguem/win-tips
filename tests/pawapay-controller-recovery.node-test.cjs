const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AppError, ErrorCodes } = require('../src/utils/AppError');

const DEPOSIT = '11111111-2222-4333-8444-555555555555';
const FOREIGN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function load(relative, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module, exports: module.exports, Date,
    console: { log() {}, warn() {}, error() {} },
    require(key) { if (!(key in mocks)) throw new Error(`Unexpected dependency ${key}`); return mocks[key]; },
  }, { filename: relative });
  return module.exports;
}

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; }, type(value) { this.contentType = value; return this; } };
}

function harness(overrides = {}) {
  const calls = { initiate: [], status: [], find: [], settle: 0, grants: 0 };
  const tx = { _id: 'transaction', depositId: DEPOSIT, user: 'owner', package: 'package',
    status: 'PENDING', amount: 1000, currency: 'XOF', processed: false, ...overrides.transaction };
  const service = {
    getProvidersAsync: async country => ({ country, providers: ['ORANGE_SEN'] }),
    initiatePayment: async (...args) => { calls.initiate.push(args); return { transaction: tx, authorizationUrl: overrides.authorizationUrl }; },
    checkTransactionStatus: async (depositId, options) => {
      calls.status.push({ depositId, options });
      if (overrides.providerError) throw overrides.providerError;
      if (options?.userId && options.userId !== tx.user) throw new AppError('Not found', 404, ErrorCodes.NOT_FOUND);
      if (overrides.providerStatus) tx.status = overrides.providerStatus;
      return tx;
    },
  };
  const middleware = { async processTransactionUpdate(transaction) {
    calls.settle++;
    if (overrides.activationError) throw overrides.activationError;
    if (transaction.status !== 'SUCCESS') return null;
    if (!transaction.processed) { calls.grants++; transaction.processed = true; }
    return { _id: 'existing-subscription', status: 'active' };
  } };
  const controller = load('src/api/controllers/user/pawapayController.js', {
    '../../services/user/PawapayService': service,
    '../../middlewares/payment/paymentMiddleware': middleware,
    '../../../utils/AppError': { AppError, ErrorCodes },
    '../../../utils/catchAsync': fn => fn,
    '../../models/user/PawapayTransaction': { findOne: async query => {
      calls.find.push(query); if (overrides.databaseError) throw overrides.databaseError;
      return query.depositId === DEPOSIT ? tx : null;
    } },
    '../../services/user/subscriptionService': { getActiveSubscriptions: async () => overrides.activeSubs || [] },
  });
  return { controller, calls, tx };
}

test('Pawa provider catalogue remains public and forwards the selected country', async () => {
  const h = harness(), res = response();
  await h.controller.getProviders({ query: { country: 'SN' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.country, 'SN');
});

test('initiation forwards pre-authorisation options and exposes the browser authorization URL', async () => {
  const url = 'https://operator.example.invalid/authorize';
  const h = harness({ authorizationUrl: url }), res = response();
  const body = { packageId: 'package', phoneNumber: '221770000000', operator: 'orange', country: 'SN',
    provider: 'ORANGE_SEN', preAuthorisationCode: 'test-code-only' };
  const user = { _id: 'owner' };
  await h.controller.initiatePayment({ body, user }, res, error => { throw error; });
  assert.equal(h.calls.initiate.length, 1);
  const args = h.calls.initiate[0];
  assert.equal(args[0], user); assert.equal(args[1], body.packageId);
  assert.equal(args[6].preAuthorisationCode, 'test-code-only');
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.authorizationUrl, url); assert.equal(res.body.data.transaction.authorizationUrl, url);
  assert.equal(/USSD/.test(res.body.message), false);
});

test('initiation also exposes a URL persisted on the transaction', async () => {
  const h = harness({ transaction: { authorizationUrl: 'https://operator.example.invalid/step' } }), res = response();
  await h.controller.initiatePayment({ body: { packageId: 'package', phoneNumber: '221770000000', provider: 'ORANGE_SEN' }, user: { _id: 'owner' } }, res, error => { throw error; });
  assert.equal(res.body.data.authorizationUrl, h.tx.authorizationUrl);
});

test('active package guard prevents an unnecessary second payment request', async () => {
  const h = harness({ activeSubs: [{ package: { _id: 'package' } }] }), res = response();
  let failure;
  await h.controller.initiatePayment({ body: { packageId: 'package', phoneNumber: '221770000000', operator: 'orange' },
    user: { _id: 'owner' } }, res, error => { failure = error; });
  assert.equal(failure.statusCode, 400); assert.equal(h.calls.initiate.length, 0);
});

test('manual status scopes the service lookup to the owner before settlement', async () => {
  const h = harness(), res = response();
  await h.controller.checkStatus({ params: { depositId: DEPOSIT }, user: { _id: 'owner' } }, res);
  assert.equal(h.calls.status[0].options.userId, 'owner');
  assert.equal(res.body.data.transaction.subscriptionActivated, false);
});

test('foreign-owner status error never reaches activation or claims success', async () => {
  const h = harness(), res = response();
  await assert.rejects(h.controller.checkStatus({ params: { depositId: DEPOSIT }, user: { _id: 'foreign' } }, res), error => error.statusCode === 404);
  assert.equal(h.calls.settle, 0); assert.equal(res.body, undefined);
});

test('verified success response includes its activated subscription and repeat status preserves it', async () => {
  const h = harness({ providerStatus: 'SUCCESS' });
  for (let n = 0; n < 2; n++) {
    const res = response(); await h.controller.checkStatus({ params: { depositId: DEPOSIT }, user: { _id: 'owner' } }, res);
    assert.equal(res.body.data.transaction.subscriptionActivated, true);
    assert.equal(res.body.data.subscription.id, 'existing-subscription');
  }
  assert.equal(h.calls.grants, 1);
});

test('manual status exposes pending browser authorization instead of reporting activation', async () => {
  const h = harness({ transaction: { authorizationUrl: 'https://operator.example.invalid/authorize' } }), res = response();
  await h.controller.checkStatus({ params: { depositId: DEPOSIT }, user: { _id: 'owner' } }, res);
  assert.equal(res.body.data.transaction.subscriptionActivated, false);
  assert.equal(res.body.data.authorizationUrl, h.tx.authorizationUrl);
});

test('activation failure in status is propagated rather than displayed as successful access', async () => {
  const failure = new Error('database offline'), h = harness({ providerStatus: 'SUCCESS', activationError: failure }), res = response();
  await assert.rejects(h.controller.checkStatus({ params: { depositId: DEPOSIT }, user: { _id: 'owner' } }, res), error => error === failure);
  assert.equal(res.body, undefined); assert.equal(h.tx.processed, false);
});

test('webhook success body cannot activate while authenticated status remains pending', async () => {
  const h = harness(), res = response();
  await h.controller.webhook({ body: { depositId: DEPOSIT, status: 'COMPLETED', amount: 999999, currency: 'USD' } }, res);
  assert.equal(res.statusCode, 503); assert.equal(h.calls.status.length, 1); assert.equal(h.calls.grants, 0);
  assert.equal(h.tx.currency, 'XOF'); assert.equal(h.tx.amount, 1000);
});

test('final callback racing a not-yet-final provider read requests retry for every terminal state', async () => {
  for (const status of ['COMPLETED', 'FAILED', 'EXPIRED']) {
    const h = harness(), res = response();
    await h.controller.webhook({ body: { depositId: DEPOSIT, status } }, res);
    assert.equal(res.statusCode, 503); assert.equal(h.calls.settle, 0);
    assert.equal(h.tx.processed, false);
  }
});

test('progress callback with authorization URL is acknowledged without claiming activation', async () => {
  const h = harness({ transaction: { status: 'INITIATED', authorizationUrl: 'https://operator.example.invalid/authorize' } });
  const res = response();
  await h.controller.webhook({ body: { depositId: DEPOSIT, status: 'PROCESSING' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.status, 'INITIATED');
  assert.equal(h.calls.grants, 0); assert.equal(h.tx.processed, false);
});

test('webhook followed by manual status grants only once and both show the same successful state', async () => {
  const h = harness({ providerStatus: 'SUCCESS' });
  for (let n = 0; n < 2; n++) {
    const res = response(); await h.controller.webhook({ body: { depositId: DEPOSIT } }, res);
    assert.equal(res.statusCode, 200);
  }
  const res = response(); await h.controller.checkStatus({ params: { depositId: DEPOSIT }, user: { _id: 'owner' } }, res);
  assert.equal(h.calls.grants, 1); assert.equal(res.body.data.transaction.subscriptionActivated, true);
});

test('provider, database and activation outages return webhook 503 for retry without private messages', async () => {
  for (const key of ['providerError', 'databaseError', 'activationError']) {
    const h = harness({ providerStatus: 'SUCCESS', [key]: new Error('secret test-only provider diagnostics') }), res = response();
    await h.controller.webhook({ body: { depositId: DEPOSIT, status: 'COMPLETED' } }, res);
    assert.equal(res.statusCode, 503); assert.equal(res.body.success, false);
    assert.equal(JSON.stringify(res.body).includes('secret'), false); assert.equal(h.tx.processed, false);
  }
});

test('unknown or malformed webhook ids cannot trigger arbitrary database/provider queries', async () => {
  const h = harness();
  for (const id of [undefined, null, '', { $ne: null }, ['value'], '../../etc', 'x'.repeat(300)]) {
    const res = response(); await h.controller.webhook({ body: { depositId: id } }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.ignored, true);
  }
  assert.equal(h.calls.find.length, 0); assert.equal(h.calls.status.length, 0);
  const res = response(); await h.controller.webhook({ body: { depositId: FOREIGN } }, res);
  assert.equal(res.body.ignored, true); assert.equal(h.calls.status.length, 0);
});

test('browser return is bilingual, does not trust query success and never grants or verifies payment', () => {
  const h = harness();
  for (const lang of ['fr', 'en', '<script>']) {
    const res = response(); h.controller.paymentReturn({ query: { lang, depositId: DEPOSIT, status: 'COMPLETED' } }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.contentType, 'html');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.includes('<script>'), false);
    assert.match(res.body, lang === 'fr' ? /Vérifiez votre paiement/ : /Check your payment/);
  }
  assert.equal(h.calls.find.length, 0); assert.equal(h.calls.status.length, 0); assert.equal(h.calls.settle, 0);
});

test('reconciliation scans paid but unprocessed purchases and recovers previous local expiry', async () => {
  const queries = [], checks = [], settlements = [];
  const rows = [
    { depositId: DEPOSIT, status: 'SUCCESS', processed: false, verifiedPaymentAt: new Date(),
      createdAt: new Date(Date.now() - 12 * 86400000), save: async () => {} },
    { depositId: FOREIGN, status: 'EXPIRED', processed: false, createdAt: new Date(Date.now() - 2 * 86400000), save: async () => {} },
  ];
  const service = load('src/api/services/user/pawapayVerificationService.js', {
    '../../models/user/PawapayTransaction': { find: async query => { queries.push(query); return rows; } },
    './PawapayService': { checkTransactionStatus: async id => { checks.push(id); return { depositId: id, status: 'SUCCESS' }; } },
    '../../middlewares/payment/paymentMiddleware': { processTransactionUpdate: async tx => { settlements.push(tx.depositId); return {}; } },
  });
  const result = await service.verifyAllPendingTransactions();
  assert.equal(result.succeeded, 2); assert.equal(checks.length, 2); assert.equal(settlements.length, 2);
  assert.equal(queries[0].processed, false); assert.equal(queries[0].$or[0].status, 'SUCCESS');
  assert.equal(queries[0].$or[0].createdAt, undefined);
  assert.ok(queries[0].$or[1].status.$in.includes('EXPIRED'));
  assert.equal(await service.expireOldPending(), 0);
  assert.equal(service.recoveryQuery('owner').user, 'owner');
});

test('reconciliation backoff retains failed-attempt timestamps and does not abandon paid transactions by age', () => {
  const service = load('src/api/services/user/pawapayVerificationService.js', {
    '../../models/user/PawapayTransaction': {}, './PawapayService': {}, '../../middlewares/payment/paymentMiddleware': {},
  });
  const now = Date.now();
  const old = { status: 'PENDING', createdAt: new Date(now - 8 * 86400000) };
  assert.equal(service.shouldCheckNow(old, now), false);
  assert.equal(service.shouldCheckNow({ ...old, status: 'SUCCESS' }, now), true);
  assert.equal(service.shouldCheckNow({ status: 'PENDING', createdAt: new Date(now - 20 * 60000), lastCheckedAt: new Date(now - 60000) }, now), false);
  assert.equal(service.shouldCheckNow({ status: 'PENDING', createdAt: new Date(now - 20 * 60000), lastCheckedAt: new Date(now - 6 * 60000) }, now), true);
});

test('manual user recovery retries paid activation after a temporary error', async () => {
  const row = { depositId: DEPOSIT, status: 'SUCCESS', processed: false, createdAt: new Date(), save: async () => {} };
  let attempts = 0, query;
  const service = load('src/api/services/user/pawapayVerificationService.js', {
    '../../models/user/PawapayTransaction': { find: async value => { query = value; return [row]; } },
    './PawapayService': { checkTransactionStatus: async () => row },
    '../../middlewares/payment/paymentMiddleware': { processTransactionUpdate: async () => { if (++attempts === 1) throw new Error('temporary'); return {}; } },
  });
  assert.equal((await service.verifyUserPendingTransactions('owner'))[0], null);
  assert.equal(query.user, 'owner'); assert.equal(row.processed, false);
  assert.ok((await service.verifyUserPendingTransactions('owner'))[0].subscription);
  assert.equal(attempts, 2);
});

test('return/providers/webhook are public while initiate and manual status require authentication', () => {
  const handlers = [], controller = { webhook() {}, paymentReturn() {}, getProviders() {}, initiatePayment() {}, checkStatus() {} };
  const protect = () => {};
  const router = { get: (route, action) => handlers.push({ route, action }), post: (route, action) => handlers.push({ route, action }),
    use: action => handlers.push({ action }) };
  load('src/api/routes/user/pawapayRoutes.js', { express: { Router: () => router },
    '../../controllers/user/pawapayController': controller, '../../middlewares/user/userAuth': { protect } });
  const auth = handlers.findIndex(item => item.action === protect);
  for (const route of ['/return', '/providers', '/webhook']) assert.ok(handlers.findIndex(item => item.route === route) < auth);
  for (const route of ['/initiate', '/status/:depositId']) assert.ok(handlers.findIndex(item => item.route === route) > auth);
});
