'use strict';
// Isolated unit tests: no .env, provider SDK, database connection or jobs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capturePurchaseSnapshot, createSettlementService, isSupportedTransaction } =
  require('../src/api/services/common/mobileMoneySettlement');
const IDS = { tx: '100000000000000000000001', user: '200000000000000000000001',
  package: '300000000000000000000001', category: '400000000000000000000001' };
const copy = value => structuredClone(value);
const clock = new Date('2026-11-18T18:00:00Z');

function match(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(part => match(row, part));
    if (value && typeof value === 'object') {
      if ('$in' in value) return value.$in.some(item => String(item) === String(row[key]));
      if ('$exists' in value) return (row[key] !== undefined) === value.$exists;
    }
    return String(row[key]) === String(value);
  });
}

function fixture(modelName = 'KorapayTransaction') {
  const rows = [], state = { indexCalls: 0, insertCalls: 0, packageReads: 0,
    ackCalls: 0, failAck: 0, failInsert: 0, failIndex: 0, forceDuplicate: false };
  const pkg = { _id: IDS.package, isActive: true, duration: 1,
    pricing: new Map([['XAF', 1000]]), categories: [IDS.category] };
  class Subscription {
    constructor(data) { Object.assign(this, { _id: `50000000000000000000000${rows.length + 1}` }, data); }
    async validate() { assert.ok(this.categorySnapshot); }
    toObject() { return copy(this); }
    static hydrate(value) { return { ...copy(value), $locals: {} }; }
  }
  Subscription.schema = { path: () => ({ cast: value => String(value) }) };
  Subscription.collection = {
    async createIndex(spec, options) {
      state.indexCalls++;
      assert.deepEqual(spec, { mobileMoneySettlementKey: 1 });
      assert.equal(options.unique, true); assert.equal(options.sparse, true);
      if (state.failIndex-- > 0) throw new Error('database unavailable for index');
    },
    async findOne(query) { return copy(rows.find(row => match(row, query)) || null); },
    async updateOne(query, update, options) {
      if (state.failInsert-- > 0) throw new Error('temporary grant write failure');
      const existing = rows.find(row => match(row, query));
      if (existing) { Object.assign(existing, update.$set || {}); return { matchedCount: 1, upsertedCount: 0 }; }
      if (options?.upsert) {
        state.insertCalls++;
        rows.push(copy(update.$setOnInsert));
        if (state.forceDuplicate) { const error = new Error('concurrent upsert won'); error.code = 11000; throw error; }
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, upsertedCount: 0 };
    }
  };
  class PSPTransaction {
    static modelName = modelName;
    static async updateOne(query, update) {
      state.ackCalls++; assert.equal(query._id, IDS.tx); assert.equal(query.status, 'SUCCESS');
      assert.deepEqual(update, { $set: { processed: true } });
      if (state.failAck-- > 0) throw new Error('crash before transaction acknowledgement');
      return { matchedCount: 1 };
    }
  }
  const transaction = () => Object.assign(new PSPTransaction(), {
    _id: IDS.tx, user: IDS.user, package: IDS.package, amount: 1000, currency: 'XAF',
    status: 'SUCCESS', processed: false, verifiedPaymentAt: clock,
    verifiedAmount: 1000, verifiedCurrency: 'XAF',
    purchaseSnapshot: capturePurchaseSnapshot(pkg, 'XAF', 1000)
  });
  const service = createSettlementService({ Subscription,
    Package: { async findById() { state.packageReads++; return pkg; } }, now: () => clock });
  return { ...service, rows, state, pkg, transaction };
}

test('snapshot freezes the purchased price, duration and distinct category IDs', () => {
  const pkg = { duration: 1, categories: [{ _id: IDS.category }, IDS.category] };
  const captured = capturePurchaseSnapshot(pkg, 'xaf', 1000);
  pkg.duration = 7; pkg.categories.length = 0;
  assert.deepEqual(captured, { amount: 1000, currency: 'XAF', duration: 1, categories: [IDS.category] });
  for (const amount of [0, -1, NaN, Infinity, '1000']) {
    assert.throws(() => capturePurchaseSnapshot(pkg, 'XAF', amount), /INVALID_SETTLEMENT_AMOUNT/);
  }
});

test('only the two supported PSP models with server confirmation may activate', async () => {
  for (const mutate of [
    tx => { tx.status = 'PROCESSING'; },
    tx => { delete tx.verifiedPaymentAt; },
    tx => { tx.verifiedAmount = 999; },
    tx => { tx.verifiedCurrency = 'XOF'; },
    tx => { tx.purchaseSnapshot.amount = 2000; },
    tx => { tx.purchaseSnapshot.currency = 'XOF'; },
  ]) {
    const f = fixture(), tx = f.transaction(); mutate(tx);
    await assert.rejects(f.settleVerifiedPayment(tx)); assert.equal(f.rows.length, 0); assert.equal(f.state.ackCalls, 0);
  }
  const f = fixture('OtherPSPTransaction');
  assert.equal(isSupportedTransaction(f.transaction()), false);
  await assert.rejects(f.settleVerifiedPayment(f.transaction()), /UNSUPPORTED_SETTLEMENT_PROVIDER/);
});

for (const provider of ['KorapayTransaction', 'PawapayTransaction']) {
  test(`${provider}: concurrent webhook, manual status and cron grant one subscription`, async () => {
    const f = fixture(provider);
    const results = await Promise.all(Array.from({ length: 20 }, () => f.settleVerifiedPayment(f.transaction())));
    assert.equal(f.rows.length, 1); assert.equal(new Set(results.map(row => row._id)).size, 1);
    assert.equal(results.filter(row => row.$locals.mobileMoneySettlementCreated).length, 1);
    assert.equal(f.state.indexCalls, 1); assert.equal(f.state.insertCalls, 1);
    assert.equal(f.rows[0].mobileMoneySettlementKey, `${provider}:${IDS.tx}`);
  });
}

test('a package disabled or repriced after purchase does not change purchased rights', async () => {
  const f = fixture(), tx = f.transaction();
  f.pkg.isActive = false; f.pkg.duration = 30; f.pkg.categories = []; f.pkg.pricing.set('XAF', 99999);
  const sub = await f.settleVerifiedPayment(tx);
  assert.equal(f.state.packageReads, 0); assert.deepEqual(sub.pricing, { amount: 1000, currency: 'XAF' });
  assert.deepEqual(sub.categorySnapshot, [IDS.category]);
  assert.equal(sub.endDate - sub.startDate, 86400000); assert.equal(tx.processed, true);
});

test('legacy unfulfilled payment uses its paid amount even when the package is inactive and repriced', async () => {
  const f = fixture(), tx = f.transaction(); delete tx.purchaseSnapshot;
  f.pkg.isActive = false; f.pkg.pricing.set('XAF', 10000);
  const sub = await f.settleVerifiedPayment(tx);
  assert.equal(f.state.packageReads, 1); assert.equal(sub.pricing.amount, 1000);
  assert.deepEqual(sub.categorySnapshot, [IDS.category]);
});

test('an expired pre-migration subscription is recovered without renewal or mutation of its rights', async () => {
  const f = fixture(), tx = f.transaction(); delete tx.purchaseSnapshot;
  f.rows.push({ _id: '500000000000000000000001', user: IDS.user, package: IDS.package,
    paymentReference: IDS.tx, paymentProvider: 'MOBILE_MONEY', status: 'expired',
    startDate: new Date('2026-11-01'), endDate: new Date('2026-11-02'),
    categorySnapshot: [], pricing: { amount: 800, currency: 'XAF' } });
  const original = copy(f.rows[0]), sub = await f.settleVerifiedPayment(tx);
  assert.equal(f.rows.length, 1); assert.equal(sub.status, 'expired'); assert.equal(f.state.packageReads, 0);
  const after = copy(f.rows[0]); delete after.mobileMoneySettlementKey; assert.deepEqual(after, original);
  assert.equal(sub.$locals.mobileMoneySettlementCreated, false);
});

test('a crash after granting access is recovered without a second subscription or longer duration', async () => {
  const f = fixture(), tx = f.transaction(); f.state.failAck = 1;
  await assert.rejects(f.settleVerifiedPayment(tx), /crash before transaction acknowledgement/);
  assert.equal(tx.processed, false); assert.equal(f.rows.length, 1);
  const original = copy(f.rows[0]); const again = await f.settleVerifiedPayment(f.transaction());
  assert.equal(again.$locals.mobileMoneySettlementCreated, false);
  assert.equal(f.rows.length, 1); assert.deepEqual(f.rows[0], original);
});

test('temporary grant failure does not mark a paid transaction processed and can be retried', async () => {
  const f = fixture(), tx = f.transaction(); f.state.failInsert = 1;
  await assert.rejects(f.settleVerifiedPayment(tx), /temporary grant write failure/);
  assert.equal(f.rows.length, 0); assert.equal(tx.processed, false); assert.equal(f.state.ackCalls, 0);
  await f.settleVerifiedPayment(tx); assert.equal(f.rows.length, 1); assert.equal(tx.processed, true);
});

test('uniqueness-index errors prevent activation and a later successful index creation permits retry', async () => {
  const f = fixture(); f.state.failIndex = 1;
  await assert.rejects(f.settleVerifiedPayment(f.transaction()), /database unavailable for index/);
  assert.equal(f.rows.length, 0); await f.settleVerifiedPayment(f.transaction());
  assert.equal(f.state.indexCalls, 2); assert.equal(f.rows.length, 1);
});

test('a duplicate-key race returns the winning grant and does not notify a second creation', async () => {
  const f = fixture(); f.state.forceDuplicate = true;
  const sub = await f.settleVerifiedPayment(f.transaction());
  assert.equal(f.rows.length, 1); assert.equal(sub.$locals.mobileMoneySettlementCreated, false);
});

test('an already processed payment returns the original grant without extending expiry', async () => {
  const f = fixture(), tx = f.transaction(); const first = await f.settleVerifiedPayment(tx);
  const original = copy(f.rows[0]); assert.equal(tx.processed, true);
  const again = await f.settleVerifiedPayment(tx);
  assert.equal(first._id, again._id); assert.equal(f.rows.length, 1); assert.deepEqual(f.rows[0], original);
});
