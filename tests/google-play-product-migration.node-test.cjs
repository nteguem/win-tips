const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pricing = require('../src/api/services/common/packagePricing');
const activation = require('../src/api/services/common/managedGoogleActivation');

const oldSku = 'com.wintips.essentiel_7days_v1', newSku = 'com.wintips.black_friday_1day_v1';
const cutoff = Date.parse('2026-11-18T03:00:00Z');
const oldCategory = '691b1dd577e0912523aab901', newCategory = '691b1dd577e0912523aab902';
function offer() {
  return { _id: 'package', catalogueKey: 'wintips-rdj-catalogue-v1:package:essentiel_7d',
    availableOnGooglePlay: true, googleProductType: 'ONE_TIME_PRODUCT', googleProductId: newSku,
    duration: 1, categories: [newCategory], pricing: { USD: 2.5, EUR: 2.49 },
    googleProductMigrations: [{ productId: oldSku, retiredAt: new Date(cutoff),
      duration: 1, categories: [oldCategory], pricing: { USD: 2.5, EUR: 10.99 } }] };
}
const paid = overrides => ({ purchaseState: 0, purchaseTimeMillis: String(cutoff - 1),
  acknowledgementState: 1, consumptionState: 0, orderId: 'TEST_ORDER', ...overrides });

// Exercise the real service and transactional activation with a small in-memory
// persistence adapter; Google is mocked, so no real purchase or API is called.
function harness({ pkg = offer(), data = paid() } = {}) {
  const state = { transactions: [], subscriptions: [] };
  const calls = { reads: [], consume: 0, acknowledge: 0, sessions: 0 };
  function query(read) {
    return { session: async () => read(), populate: async () => read(),
      then: (resolve, reject) => Promise.resolve(read()).then(resolve, reject) };
  }
  const transactions = {
    db: { startSession: async () => ({ withTransaction: async fn => { calls.sessions++; await fn(); }, endSession: async () => {} }) },
    findOne: criteria => query(() => state.transactions.find(row => row.purchaseToken === criteria.purchaseToken)),
    create: async rows => { state.transactions.push(...rows); return rows; },
    updateOne: async (criteria, update) => Object.assign(state.transactions.find(row => row._id === criteria._id), update.$set),
    findOneAndUpdate: async (criteria, update) => Object.assign(state.transactions.find(row => row.purchaseToken === criteria.purchaseToken), update),
  };
  const subscriptions = {
    findById: id => query(() => state.subscriptions.find(row => row._id === id)),
    create: async rows => rows.map(row => { const result = { ...row, _id: new (require('mongoose').Types.ObjectId)().toString() }; state.subscriptions.push(result); return result; }),
  };
  const dependencies = {
    googleapis: { google: { auth: { GoogleAuth: class {} }, androidpublisher: () => ({ purchases: { products: {
      get: async payload => { calls.reads.push(payload); return { data }; },
      consume: async () => { calls.consume++; }, acknowledge: async () => { calls.acknowledge++; },
    } } }) } },
    '../../models/common/Package': { findById: async () => pkg },
    '../../models/common/Subscription': subscriptions,
    '../../models/user/GooglePlayTransaction': transactions,
    '../common/packagePricing': pricing, '../common/managedGoogleActivation': activation,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/services/user/GooglePlayService.js'), 'utf8'), {
    module, process: { env: { GOOGLE_PLAY_PACKAGE_NAME: 'test.only.wintips' } },
    console: { log() {}, error() {}, warn() {} }, require: key => dependencies[key],
  });
  return { service: module.exports, state, calls, pkg, data };
}
const validate = (h, sku = oldSku, currency = 'EUR', user = 'owner') =>
  h.service.validateOneTimePurchase('TEST_PRIVATE_TOKEN', sku, user, h.pkg._id, currency);

test('new checkout remains strictly bound to the active SKU and its current price', async () => {
  const h = harness();
  assert.throws(() => pricing.managedGooglePrice(h.pkg, oldSku, 'EUR'), /non configure/);
  assert.equal(h.pkg.googleProductId, newSku);
  await validate(h, newSku, 'USD');
  assert.equal(h.calls.reads[0].productId, newSku);
  assert.equal(h.state.subscriptions[0].pricing.amount, 2.5);
  assert.deepEqual(h.state.subscriptions[0].categorySnapshot, [newCategory]);
});

test('a paid retired-SKU receipt preserves its snapshot, including a deferred payment completed after retirement', async () => {
  for (const time of [cutoff - 1, cutoff, cutoff + 7 * 86400000]) {
    const h = harness({ data: paid({ purchaseTimeMillis: String(time) }) });
    await validate(h);
    assert.equal(h.calls.reads[0].productId, oldSku);
    assert.equal(h.state.transactions.length, 1); assert.equal(h.state.subscriptions.length, 1);
    const sub = h.state.subscriptions[0], tx = h.state.transactions[0];
    assert.equal(sub.pricing.amount, 10.99); assert.equal(sub.pricing.currency, 'EUR');
    assert.equal(tx.priceAmountMicros, 10990000);
    assert.equal(+sub.endDate - +sub.startDate, 86400000);
    assert.deepEqual(sub.categorySnapshot, [oldCategory]);
    assert.equal(h.pkg.pricing.EUR, 2.49); assert.deepEqual(h.pkg.categories, [newCategory]);
  }
});

test('retired pending, cancelled or unverified receipts never grant access', async () => {
  const invalid = [
    { purchaseState: 2 }, { purchaseState: 1 },
    { purchaseTimeMillis: undefined }, { purchaseTimeMillis: 'invalid' },
    { purchaseTimeMillis: '' }, { purchaseTimeMillis: null }, { purchaseTimeMillis: '0' },
    { productId: 'a-different-product' },
  ];
  for (const change of invalid) {
    const h = harness({ data: paid(change) });
    await assert.rejects(validate(h), /historique non confirme/);
    assert.equal(h.calls.reads.length, 1); assert.equal(h.calls.sessions, 0);
    assert.equal(h.state.transactions.length, 0); assert.equal(h.state.subscriptions.length, 0);
    assert.equal(h.calls.consume, 0);
  }
});

test('unknown, ambiguous or incomplete historical configuration fails before a provider call', async () => {
  for (const change of [
    pkg => { delete pkg.googleProductMigrations; },
    pkg => { pkg.googleProductMigrations.push({ ...pkg.googleProductMigrations[0] }); },
    pkg => { pkg.googleProductMigrations[0].retiredAt = 'invalid'; },
    pkg => { pkg.googleProductMigrations[0].duration = 0; },
    pkg => { pkg.googleProductMigrations[0].categories = []; },
    pkg => { pkg.googleProductMigrations[0].pricing = {}; },
  ]) {
    const pkg = offer(); change(pkg); const h = harness({ pkg });
    await assert.rejects(validate(h));
    assert.equal(h.calls.reads.length, 0); assert.equal(h.calls.sessions, 0);
  }
});

test('receipt recovery and repeated validation preserve original price, dates, expiry and entitlement', async () => {
  const h = harness(); await validate(h);
  h.state.subscriptions[0].status = 'expired'; h.state.transactions[0].status = 'EXPIRED';
  const original = JSON.stringify(h.state);
  h.data.consumptionState = 1;
  const beforeConsume = h.calls.consume;
  const restored = await validate(h);
  await validate(h);
  assert.equal(JSON.stringify(h.state), original);
  assert.equal(restored.data.subscription.status, 'expired');
  assert.equal(h.state.subscriptions.length, 1); assert.equal(h.state.transactions.length, 1);
  assert.equal(h.calls.consume, beforeConsume, 'already consumed purchases are not consumed twice');
});

test('historical tokens cannot be replayed by another user, package or product', async () => {
  for (const field of ['user', 'package', 'productId']) {
    const h = harness(); await validate(h);
    h.state.transactions[0][field] = 'foreign';
    const original = JSON.stringify(h.state);
    await assert.rejects(validate(h), /autre activation/);
    assert.equal(JSON.stringify(h.state), original);
    assert.equal(h.state.subscriptions.length, 1);
  }
});

test('other packages keep their original strict product binding and unmanaged pricing behavior', () => {
  const managed = offer(); delete managed.googleProductMigrations;
  assert.throws(() => pricing.managedGooglePurchase(managed, oldSku, 'EUR'), /incompatible/);
  const legacy = { googleProductId: 'legacy' };
  assert.deepEqual(pricing.managedGooglePurchase(legacy, 'legacy', 'USD'), { pkg: legacy, price: null, migration: null });
  assert.throws(() => pricing.managedGooglePurchase(legacy, 'other', 'USD'), /incompatible/);
});

test('historical mappings are private in localized catalogue and populated package JSON', () => {
  const Package = require('../src/api/models/common/Package');
  const pkg = new Package({ ...offer(), _id: 'c97d577e0912523aab9f1bfb', name: { fr: 'Black Friday', en: 'Black Friday' } });
  assert.equal(pkg.googleProductMigrations.length, 1);
  assert.equal(pkg.formatForLanguage('fr').googleProductMigrations, undefined);
  assert.equal(pkg.formatForLanguage('en').googleProductMigrations, undefined);
  assert.equal(pkg.toJSON().googleProductMigrations, undefined);
  assert.equal(pkg.formatForLanguage('fr').googleProductId, newSku);
});

test('a real populated subscription and nested validation response never expose historical product snapshots', () => {
  const Package = require('../src/api/models/common/Package');
  const Subscription = require('../src/api/models/common/Subscription');
  const pkg = new Package({ ...offer(), _id: 'c97d577e0912523aab9f1bfb', name: { fr: 'Black Friday', en: 'Black Friday' } });
  const subscription = new Subscription({ package: pkg, user: '691b1dd577e0912523aab903',
    endDate: new Date(cutoff + 86400000), pricing: { amount: 10.99, currency: 'EUR' } });
  assert.equal(subscription.package.googleProductMigrations.length, 1, 'package is genuinely populated');
  assert.equal(subscription.toObject().package.googleProductMigrations.length, 1, 'raw mongoose flattening reproduces the leakage path');
  assert.equal(subscription.toJSON().package.googleProductMigrations, undefined);
  const response = JSON.parse(JSON.stringify({ status: 'success', data: { subscription } }));
  assert.equal(JSON.stringify(response).includes('googleProductMigrations'), false);
  assert.equal(response.data.subscription.package.googleProductId, newSku);
  assert.equal(response.data.subscription.pricing.amount, 10.99);
  assert.equal(subscription.package.googleProductMigrations.length, 1, 'serialization never mutates stored migration evidence');
});

// All currency codes observed in the official 174-region Black Friday product.
// Amounts here are synthetic positive configured prices, not pricing fixtures.
const officialStoreCurrencies = 'AED ARS AUD AZN BDT BOB BRL CAD CHF CLP COP CRC CZK DKK DZD EGP ETB EUR GBP GEL GHS HKD HUF IDR ILS INR IQD JOD JPY KES KRW KZT LKR MAD MMK MNT MOP MXN MYR NGN NOK NZD PEN PHP PKR PLN PYG QAR RON RSD RUB SAR SEK SGD THB TRY TWD TZS UAH USD UZS VND XAF XOF ZAR'.split(' ');

test('all 65 actual Store currencies pass catalogue preflight and managed receipt activation with valid Mongoose records', async () => {
  const Subscription = require('../src/api/models/common/Subscription');
  const GooglePlayTransaction = require('../src/api/models/user/GooglePlayTransaction');
  const Package = require('../src/api/models/common/Package');
  const pkg = new Package({ ...offer(), _id: 'c97d577e0912523aab9f1bfb', name: { fr: 'Black Friday', en: 'Black Friday' },
    pricing: Object.fromEntries(officialStoreCurrencies.map(currency => [currency, currency === 'GBP' ? 2.29 : 10])) });
  for (const currency of officialStoreCurrencies) {
    assert.equal(pricing.canPurchaseInCurrency(pkg.formatForLanguage('en'), currency), true, currency);
    assert.equal(pricing.managedGooglePrice(pkg, newSku, currency).currency, currency);
    const h = harness({ pkg });
    await validate(h, newSku, currency, '691b1dd577e0912523aab903');
    const subscription = new Subscription(h.state.subscriptions[0]);
    const transaction = new GooglePlayTransaction(h.state.transactions[0]);
    assert.equal(subscription.validateSync(), undefined, currency + ' subscription');
    assert.equal(transaction.validateSync(), undefined, currency + ' receipt');
    assert.equal(subscription.pricing.currency, currency);
    assert.equal(transaction.priceCurrencyCode, currency);
    if (currency === 'GBP') assert.equal(subscription.pricing.amount, 2.29);
  }
});

test('extra Store currencies stay unavailable without an explicit SKU quote and remain rejected by other payment rails', () => {
  const Subscription = require('../src/api/models/common/Subscription');
  const fields = { user: '691b1dd577e0912523aab903', package: 'c97d577e0912523aab9f1bfb',
    categorySnapshot: [oldCategory], endDate: new Date(cutoff + 86400000) };
  for (const currency of ['GBP', 'BRL', 'INR', 'JPY', 'KRW', 'CHF', 'CAD', 'AUD']) {
    assert.equal(pricing.canPurchaseInCurrency(offer(), currency), false);
    assert.throws(() => pricing.managedGooglePrice(offer(), newSku, currency), /non configure/);
    for (const paymentProvider of ['MOBILE_MONEY', 'ADS']) {
      const row = new Subscription({ ...fields, paymentProvider, pricing: { amount: 1, currency } });
      assert.ok(row.validateSync()?.errors['pricing.currency'], `${paymentProvider}/${currency}`);
    }
  }
  for (const currency of ['ABC', 'gbp', 'USD ', '']) {
    const row = new Subscription({ ...fields, paymentProvider: 'GOOGLE_PLAY', pricing: { amount: 1, currency } });
    assert.ok(row.validateSync()?.errors['pricing.currency'], currency);
  }
  for (const paymentProvider of ['MOBILE_MONEY', 'ADS', 'GOOGLE_PLAY']) {
    const row = new Subscription({ ...fields, paymentProvider, pricing: { amount: 1, currency: 'XAF' } });
    assert.equal(row.validateSync(), undefined, paymentProvider + ' retains XAF');
  }
});
