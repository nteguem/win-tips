'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const currency = require('../src/utils/currency');

// Monetary regression snapshot, 2026-11-23: 1 000 XOF + 2.10 CHF = 2 493 XAF.
// Synthetic records only: no production identity, transaction or credentials.
const INSTANT = '2026-11-23T12:00:00.000Z';
const PACKAGE_ID = 'a'.repeat(24);
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [INSTANT])); }
  static now() { return Date.parse(INSTANT); }
  // Keep this fixture independent of the test runner's local timezone.
  setHours(...args) { return this.setUTCHours(...args); }
}

const records = [
  { _id: 'sale-xof', user: 'test-user-a', package: PACKAGE_ID, paymentProvider: 'MOBILE_MONEY',
    pricing: { amount: 1000, currency: 'XOF' }, status: 'expired', createdAt: new Date('2026-11-23T08:00:00Z') },
  { _id: 'sale-chf', user: 'test-user-b', package: PACKAGE_ID, paymentProvider: 'GOOGLE_PLAY',
    pricing: { amount: 2.10, currency: 'CHF' }, status: 'active', createdAt: new Date('2026-11-23T09:00:00Z') },
  { _id: 'ads-access', user: 'test-user-c', package: PACKAGE_ID, paymentProvider: 'ADS',
    pricing: { amount: 0, currency: 'XAF' }, status: 'active', createdAt: new Date('2026-11-23T10:00:00Z') },
  { _id: 'previous-sale-chf', user: 'test-user-d', package: PACKAGE_ID, paymentProvider: 'GOOGLE_PLAY',
    pricing: { amount: 2.10, currency: 'CHF' }, status: 'expired', createdAt: new Date('2026-11-22T18:00:00Z') },
  { _id: 'previous-ads', user: 'test-user-e', package: PACKAGE_ID, paymentProvider: 'ADS',
    pricing: { amount: 0, currency: 'XAF' }, status: 'expired', createdAt: new Date('2026-11-22T20:00:00Z') },
  { _id: 'outside-range', user: 'test-user-f', package: PACKAGE_ID, paymentProvider: 'MOBILE_MONEY',
    pricing: { amount: 9000, currency: 'XOF' }, status: 'expired', createdAt: new Date('2026-11-20T08:00:00Z') },
];

function field(row, dotted) {
  return dotted.split('.').reduce((value, key) => value?.[key], row);
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = field(row, key);
    if (!expected || typeof expected !== 'object' || expected instanceof Date) return actual === expected;
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === '$gte') return actual >= value;
      if (operator === '$lte') return actual <= value;
      if (operator === '$gt') return actual > value;
      if (operator === '$lt') return actual < value;
      if (operator === '$in') return value.includes(actual);
      throw Error('Unsupported fixture filter: ' + operator);
    });
  });
}

function expression(row, value) {
  if (typeof value === 'string' && value.startsWith('$')) return field(row, value.slice(1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expression(row, item)]));
  }
  return value;
}

// A small in-memory aggregate fixture applies the actual controller match/group
// stages. Database models and joins stay mocked; conversion uses the real code.
function aggregateRows(pipeline) {
  let rows = records.map(row => ({ ...row, pricing: { ...row.pricing } }));
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
    else if (stage.$group) {
      const groups = new Map();
      for (const row of rows) {
        const id = expression(row, stage.$group._id);
        const key = JSON.stringify(id);
        if (!groups.has(key)) groups.set(key, { _id: id });
        const result = groups.get(key);
        for (const [name, accumulator] of Object.entries(stage.$group)) {
          if (name === '_id') continue;
          assert.ok(Object.hasOwn(accumulator, '$sum'));
          const value = expression(row, accumulator.$sum);
          result[name] = (result[name] || 0) + (typeof value === 'number' ? value : 0);
        }
      }
      rows = [...groups.values()];
    } else if (stage.$sort) rows.sort((a, b) => b.createdAt - a.createdAt);
    else if (stage.$lookup) {
      rows = rows.map(row => ({ ...row, [stage.$lookup.as]: [{ _id: row[stage.$lookup.localField] }] }));
    } else if (stage.$unwind) {
      const key = stage.$unwind.path.slice(1);
      rows = rows.map(row => ({ ...row, [key]: row[key][0] }));
    } else if (stage.$facet) {
      const skip = stage.$facet.data.find(item => Object.hasOwn(item, '$skip')).$skip;
      const limit = stage.$facet.data.find(item => Object.hasOwn(item, '$limit')).$limit;
      return [{ data: rows.slice(skip, skip + limit), total: [{ count: rows.length }] }];
    } else throw Error('Unsupported fixture aggregate stage');
  }
  return rows;
}

function loadController(filename) {
  const aggregateCalls = [];
  const subscription = {
    aggregate: async pipeline => { aggregateCalls.push(pipeline); return aggregateRows(pipeline); },
    distinct: async () => ['test-user-b'],
    countDocuments: async () => 1,
    find: () => { throw Error('Historical revenue must not use the expiring Subscription.find hook'); },
  };
  const mocks = {
    '../../models/common/Subscription': subscription,
    '../../models/user/User': { countDocuments: async () => 0 },
    '../../models/common/Package': { find: () => ({ select: async () => [{ _id: PACKAGE_ID, name: { fr: 'Forfait test' } }] }) },
    '../../models/common/Prediction': { aggregate: async () => [] },
    '../../../utils/catchAsync': fn => fn,
    '../../../utils/currency': currency,
  };
  const file = path.resolve(__dirname, '../src/api/controllers/admin', filename);
  const module = { exports: {} };
  const factory = vm.runInThisContext('(function(require,module,exports,Date){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
  factory(name => {
    assert.ok(Object.hasOwn(mocks, name), 'Unexpected dependency: ' + name);
    return mocks[name];
  }, module, module.exports, Clock);
  return { controller: module.exports, aggregateCalls };
}

async function responseFrom(handler, query) {
  let status, body;
  const response = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  await handler({ query }, response);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  return body.data;
}

const dateQuery = { startDate: '2026-11-23T00:00:00Z', endDate: INSTANT };

test('2026-11-23 currency snapshot converts the actual CHF amount instead of silently returning zero', () => {
  assert.equal(currency.toXAF(1000, 'XOF'), 1000);
  assert.equal(currency.toXAF(2.10, 'CHF'), 1493);
  assert.equal(currency.toXAF(1000, 'XOF') + currency.toXAF(2.10, 'CHF'), 2493);
});

test('dashboard reconciles both monetary sales, currency rows and top package while excluding ADS', async () => {
  const { controller } = loadController('dashboardController.js');
  const data = await responseFrom(controller.getDashboardStats, { period: 'today' });
  assert.equal(data.sales.count, 2);
  assert.equal(data.sales.revenueXAF, 2493);
  assert.equal(data.sales.adsCount, 1);
  assert.deepEqual(data.sales.byCurrency, [
    { currency: 'XOF', count: 1, amount: 1000, amountXAF: 1000 },
    { currency: 'CHF', count: 1, amount: 2.10, amountXAF: 1493 },
  ]);
  assert.deepEqual(data.topPackages, [{ packageId: PACKAGE_ID, name: 'Forfait test', count: 2, revenueXAF: 2493 }]);
  assert.equal(data.sales.byCurrency.reduce((sum, row) => sum + row.amountXAF, 0), data.sales.revenueXAF);
});

test('dashboard previous-period comparison also converts CHF and excludes advertising access', async () => {
  const { controller, aggregateCalls } = loadController('dashboardController.js');
  const data = await responseFrom(controller.getDashboardStats, { period: 'today' });
  assert.equal(data.sales.trend.count, 100); // Two current paid sales / one previous paid sale.
  assert.equal(data.sales.trend.revenueXAF, 67); // (2493 - 1493) / 1493, rounded.
  assert.equal(aggregateCalls.length, 3);
  const previousMatch = aggregateCalls[1][0].$match;
  assert.equal(previousMatch.createdAt.$gte.toISOString(), '2026-11-22T12:00:00.000Z');
  assert.equal(previousMatch.createdAt.$lt.toISOString(), '2026-11-23T00:00:00.000Z');
  assert.deepEqual(previousMatch.paymentProvider.$in, ['MOBILE_MONEY', 'GOOGLE_PLAY']);
});

test('subscription stats convert all monetary rows without changing the existing ADS-inclusive count', async () => {
  const { controller } = loadController('subscriptionController.js');
  const data = await responseFrom(controller.getSubscriptionStats, dateQuery);
  assert.equal(data.totalCount, 3);
  assert.equal(data.totalRevenueXAF, 2493);
  assert.deepEqual(data.byProvider, [
    { provider: 'MOBILE_MONEY', count: 1, revenueXAF: 1000 },
    { provider: 'GOOGLE_PLAY', count: 1, revenueXAF: 1493 },
    { provider: 'ADS', count: 1, revenueXAF: 0 },
  ]);
  assert.deepEqual(data.byCurrency, [
    { currency: 'XOF', count: 1, amount: 1000, amountXAF: 1000 },
    { currency: 'CHF', count: 1, amount: 2.10, amountXAF: 1493 },
    { currency: 'XAF', count: 1, amount: 0, amountXAF: 0 },
  ]);
  assert.deepEqual(data.byStatus, [{ status: 'expired', count: 1 }, { status: 'active', count: 2 }]);
});

test('subscription listing exposes CHF conversion, original currency and historical expired records', async () => {
  const { controller } = loadController('subscriptionController.js');
  const data = await responseFrom(controller.getSubscriptions, { ...dateQuery, page: '1', limit: '20' });
  assert.equal(data.pagination.total, 3);
  assert.equal(data.subscriptions.length, 3);
  const chf = data.subscriptions.find(row => row._id === 'sale-chf');
  assert.deepEqual(chf.pricing, { amount: 2.10, currency: 'CHF' });
  assert.equal(chf.revenueXAF, 1493);
  const xof = data.subscriptions.find(row => row._id === 'sale-xof');
  assert.equal(xof.status, 'expired');
  assert.equal(xof.revenueXAF, 1000);
  assert.equal(data.subscriptions.find(row => row._id === 'ads-access').revenueXAF, 0);
  assert.equal(data.subscriptions.reduce((sum, row) => sum + row.revenueXAF, 0), 2493);
});

test('provider filter keeps Google Play CHF revenue consistent between subscription stats and list', async () => {
  const { controller } = loadController('subscriptionController.js');
  const query = { ...dateQuery, provider: 'GOOGLE_PLAY' };
  const stats = await responseFrom(controller.getSubscriptionStats, query);
  const list = await responseFrom(controller.getSubscriptions, query);
  assert.equal(stats.totalCount, 1);
  assert.equal(stats.totalRevenueXAF, 1493);
  assert.equal(list.pagination.total, stats.totalCount);
  assert.equal(list.subscriptions[0].revenueXAF, stats.totalRevenueXAF);
});
