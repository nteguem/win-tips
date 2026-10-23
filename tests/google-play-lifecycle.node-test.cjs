const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const now = Date.parse('2026-10-23T21:00:00Z');
class Clock extends Date {
  constructor(value) { super(arguments.length ? value : now); }
  static now() { return now; }
}
const token = 'TEST_PRIVATE_PURCHASE_TOKEN_NEVER_LOG';
function transaction(type = 'ONE_TIME_PRODUCT') {
  return { _id: 'tx', user: 'owner', purchaseToken: token, purchaseType: type, status: 'ACTIVE',
    expiryTime: new Date(now + 7 * 86400000), autoRenewing: false,
    subscription: { _id: 'sub', user: 'owner', status: 'active', endDate: new Date(now + 7 * 86400000) } };
}
function loadService(tx, overrides = {}) {
  const calls = { provider: [], saved: 0, updates: [], logs: [], queries: [] };
  if (tx) tx.save = async () => { calls.saved++; };
  const failure = Object.assign(new Error('private ' + token), { response: { status: 503, data: { error: { status: 'UNAVAILABLE', message: token } } }, config: { url: '/tokens/' + token } });
  const sdk = { google: { auth: { GoogleAuth: class {} }, androidpublisher: () => ({ purchases: {
    subscriptionsv2: { get: async payload => { calls.provider.push(payload); if (overrides.providerFailure) throw failure;
      return { data: overrides.providerData || { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{ expiryTime: new Date(now + 14 * 86400000).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }] } }; } },
    products: { consume: async payload => { calls.provider.push(payload); if (overrides.providerFailure) throw failure; },
      acknowledge: async payload => { calls.provider.push(payload); if (overrides.providerFailure) throw failure; } },
  } }) } };
  const mocks = {
    googleapis: sdk,
    '../../models/user/GooglePlayTransaction': {
      findOne(query) { calls.queries.push(query); return { populate: async () => tx, then: (resolve, reject) => Promise.resolve(tx).then(resolve, reject) }; },
      findOneAndUpdate: async (...args) => calls.updates.push(args),
    },
    '../../models/common/Subscription': { findByIdAndUpdate: async (...args) => calls.updates.push(args) },
    '../../models/common/Package': {},
    '../common/packagePricing': require('../src/api/services/common/packagePricing'),
    '../common/managedGoogleActivation': require('../src/api/services/common/managedGoogleActivation'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/services/user/GooglePlayService.js'), 'utf8'), {
    module, Date: Clock, process: { env: { GOOGLE_PLAY_PACKAGE_NAME: 'test.only.wintips' } },
    console: { log: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args) },
    require: key => { if (!(key in mocks)) throw new Error('Unexpected dependency: ' + key); return mocks[key]; },
  });
  return { service: module.exports, calls };
}

test('fixed-duration one-time status uses the persisted entitlement without a subscription RPC or write', async () => {
  const tx = transaction(), { service, calls } = loadService(tx);
  const result = await service.checkSubscriptionStatus('owner');
  assert.equal(result.hasActiveSubscription, true); assert.equal(result.autoRenewing, false);
  assert.equal(result.subscription, tx.subscription); assert.equal(result.expiryDate.getTime(), +tx.expiryTime);
  assert.equal(calls.provider.length, 0); assert.equal(calls.saved, 0); assert.equal(calls.updates.length, 0);
});

test('both fixed durations close status exactly at expiry and never reopen or extend it', async t => {
  for (const days of [7, 14]) for (const offset of [-1, 0, 1]) {
    await t.test(`${days} days / now ${offset} ms from end`, async () => {
      const tx = transaction(); tx.startTime = new Date(now - days * 86400000 - offset);
      tx.expiryTime = new Date(now - offset); tx.subscription.endDate = new Date(now - offset);
      const before = JSON.stringify(tx), { service, calls } = loadService(tx);
      const result = await service.checkSubscriptionStatus('owner');
      assert.equal(result.hasActiveSubscription, offset < 0);
      assert.equal(JSON.stringify(tx), before); assert.equal(calls.provider.length, 0); assert.equal(calls.saved, 0);
    });
  }
});

test('one-time status fails closed for orphaned, expired, foreign, cancelled or invalid stored rights', async () => {
  const changes = [
    tx => { tx.subscription = null; }, tx => { tx.subscription.user = 'another-user'; },
    tx => { tx.subscription.status = 'expired'; }, tx => { tx.subscription.endDate = new Date(now); },
    tx => { tx.expiryTime = new Date(now); }, tx => { tx.status = 'CANCELED'; },
    tx => { tx.subscription.endDate = 'invalid'; },
  ];
  for (const change of changes) {
    const tx = transaction(); change(tx); const { service, calls } = loadService(tx);
    const result = await service.checkSubscriptionStatus('owner');
    assert.equal(result.hasActiveSubscription, false);
    if (tx.subscription?.user === 'another-user') { assert.equal(result.subscription, null); assert.equal(result.expiryDate, null); }
    assert.equal(calls.provider.length, 0); assert.equal(calls.saved, 0);
  }
});

test('explicit and historical subscriptions retain the existing Google status check', async () => {
  for (const type of ['SUBSCRIPTION', undefined]) {
    const tx = transaction(type); if (type === undefined) delete tx.purchaseType;
    const { service, calls } = loadService(tx); const result = await service.checkSubscriptionStatus('owner');
    assert.equal(result.hasActiveSubscription, true); assert.equal(calls.provider.length, 1);
    assert.equal(calls.provider[0].token, token);
  }
});

test('manual sync of a one-time purchase performs neither Google subscription lookup nor database update', async () => {
  const tx = transaction(), before = JSON.stringify(tx), { service, calls } = loadService(tx);
  assert.equal(await service.syncSubscription(token), tx);
  assert.equal(JSON.stringify(tx), before); assert.equal(calls.provider.length, 0); assert.equal(calls.saved, 0); assert.equal(calls.updates.length, 0);
});

test('legacy recurring sync still applies Google renewal dates and state to the same record', async () => {
  for (const type of ['SUBSCRIPTION', undefined]) {
    const tx = transaction(type); if (type === undefined) delete tx.purchaseType;
    const { service, calls } = loadService(tx); assert.equal(await service.syncSubscription(token), tx);
    assert.equal(calls.provider.length, 1); assert.equal(calls.saved, 1); assert.equal(calls.updates.length, 1);
    assert.equal(tx.expiryTime.getTime(), now + 14 * 86400000); assert.equal(tx.status, 'ACTIVE'); assert.equal(tx.autoRenewing, true);
  }
});

test('success and provider-failure logs omit purchase tokens, provider URLs, bodies and messages', async () => {
  for (const providerFailure of [false, true]) {
    const { service, calls } = loadService(transaction(), { providerFailure });
    await service.consumeOneTimePurchase(token, 'TEST_SKU');
    await service.acknowledgeAndConsumeOneTimePurchase(token, 'TEST_SKU');
    const logged = JSON.stringify(calls.logs);
    assert.equal(logged.includes(token), false); assert.equal(logged.includes('/tokens/'), false);
    if (providerFailure) assert.ok(logged.includes('503'));
  }
  const { service, calls } = loadService(transaction('SUBSCRIPTION'), { providerFailure: true });
  await service.checkSubscriptionStatus('owner'); await assert.rejects(service.syncSubscription(token));
  assert.equal(JSON.stringify(calls.logs).includes(token), false);
});

function matches(document, query) {
  return Object.entries(query).every(([key, criterion]) => {
    if (key === '$or') return criterion.some(part => matches(document, part));
    const value = document[key];
    if (criterion && typeof criterion === 'object' && !(criterion instanceof Date)) {
      if ('$in' in criterion) return criterion.$in.includes(value);
      if ('$gt' in criterion) return +new Date(value) > +new Date(criterion.$gt);
      if ('$exists' in criterion) return Object.hasOwn(document, key) === criterion.$exists;
    }
    return value === criterion;
  });
}
function loadJobs(documents, { throwSync = false } = {}) {
  const callbacks = {}, calls = { synced: [], queries: [], logs: [] };
  const mocks = {
    'node-cron': { schedule: (expression, callback) => { callbacks[expression] = callback; return { start() {}, stop() {} }; } },
    '../api/models/user/GooglePlayTransaction': { find: async query => { calls.queries.push(query); return documents.filter(row => matches(row, query)); } },
    '../api/models/common/Subscription': {},
    '../api/services/user/GooglePlayService': { syncSubscription: async value => { calls.synced.push(value); if (throwSync) throw new Error(token); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/jobs/googlePlaySyncJob.js'), 'utf8'), {
    module, Date: Clock, console: { log: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) },
    require: key => { if (!(key in mocks)) throw new Error('Unexpected dependency: ' + key); return mocks[key]; },
  });
  return { callbacks, calls };
}

test('the six-hour query selects only recurring and untyped legacy subscriptions, never explicit consumables', async () => {
  const legacy = transaction(); delete legacy.purchaseType; legacy.purchaseToken = 'TEST_LEGACY';
  const recurring = transaction('SUBSCRIPTION'); recurring.purchaseToken = 'TEST_RECURRING';
  const expired = transaction('SUBSCRIPTION'); expired.expiryTime = new Date(now);
  const unknown = transaction('UNKNOWN');
  const { callbacks, calls } = loadJobs([transaction(), recurring, legacy, expired, unknown]);
  await callbacks['0 */6 * * *']();
  assert.deepEqual(calls.synced, ['TEST_RECURRING', 'TEST_LEGACY']);
  assert.equal(calls.queries.length, 1); assert.ok(calls.queries[0].$or);
});

test('a recurring sync failure is isolated and its token/message never enters scheduler logs', async () => {
  const tx = transaction('SUBSCRIPTION'), { callbacks, calls } = loadJobs([tx], { throwSync: true });
  await callbacks['0 */6 * * *'](); assert.equal(calls.synced.length, 1);
  assert.equal(JSON.stringify(calls.logs).includes(token), false);
});

test('the RTDN controller keeps dispatching without logging headers, encoded bodies or decoded purchase tokens', async () => {
  const calls = { logs: [], dispatched: [] }, exports = {};
  const mocks = {
    '../../../utils/catchAsync': fn => fn,
    '../../../utils/AppError': { AppError: Error },
    '../../services/user/GooglePlayService': { processNotification: async notification => calls.dispatched.push(notification) },
    '../../models/common/Package': {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/controllers/user/googlePlayController.js'), 'utf8'), {
    exports, Buffer, console: { log: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) },
    require: key => { if (!(key in mocks)) throw new Error(key); return mocks[key]; },
  });
  const response = { status(code) { assert.equal(code, 200); return this; }, send() {}, json() {} };
  const notification = { oneTimeProductNotification: { purchaseToken: token, notificationType: 1 } };
  const encoded = Buffer.from(JSON.stringify(notification)).toString('base64');
  await exports.handleRTDN({ headers: { authorization: 'SECRET_AUTH_TEST' }, body: { message: { data: encoded } } }, response);
  assert.equal(calls.dispatched.length, 1);
  const logged = JSON.stringify(calls.logs);
  assert.equal(logged.includes(token), false); assert.equal(logged.includes(encoded), false); assert.equal(logged.includes('SECRET_AUTH_TEST'), false);
});
