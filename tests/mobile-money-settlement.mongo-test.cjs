'use strict';
// Explicit opt-in local database only. Never loads .env or a provider SDK and
// never downloads MongoDB: a previously installed runtime and binary are required.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) {
  throw new Error('Explicit disposable Mongo runtime/binary required');
}
const mongoose = require('mongoose');
const { MongoMemoryServer } = require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const subscriptionSchema = require('../src/api/models/common/Subscription').schema;
const { capturePurchaseSnapshot, createSettlementService } =
  require('../src/api/services/common/mobileMoneySettlement');
const DB_NAME = 'wintips_mobile_money_settlement_disposable';
const now = new Date('2026-11-18T20:00:00Z');
const oid = () => new mongoose.Types.ObjectId();
let server, connection, Subscription, Package, providers, service, pkg, user;

before(async () => {
  server = await MongoMemoryServer.create({
    binary: { systemBinary: process.env.WINTIPS_TEST_MONGO_BINARY },
    instance: { dbName: DB_NAME, ip: '127.0.0.1', port: 48173, args: [
      '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'
    ] },
    spawn: { windowsHide: true }
  });
  const uri = server.getUri(DB_NAME); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  assert.notEqual(new URL(uri).port, '27017');
  connection = await mongoose.createConnection(uri, {
    autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000
  }).asPromise();
  assert.equal(connection.db.databaseName, DB_NAME);
  Subscription = connection.model('Subscription', subscriptionSchema);
  Package = connection.model('Package', new mongoose.Schema({
    duration: Number, categories: [mongoose.Schema.Types.ObjectId],
    pricing: { type: Map, of: Number }, isActive: Boolean
  }));
  const txSchema = new mongoose.Schema({
    user: mongoose.Schema.Types.ObjectId, package: mongoose.Schema.Types.ObjectId,
    amount: Number, currency: String, status: String, processed: Boolean,
    verifiedPaymentAt: Date, verifiedAmount: Number, verifiedCurrency: String,
    purchaseSnapshot: mongoose.Schema.Types.Mixed
  });
  providers = ['KorapayTransaction', 'PawapayTransaction'].map(name => connection.model(name, txSchema));
  for (const model of [Subscription, Package, ...providers]) await model.createCollection();
  service = createSettlementService({ Subscription, Package, now: () => now });
}, { timeout: 180000 });

beforeEach(async () => {
  assert.equal(connection.db.databaseName, DB_NAME);
  for (const model of [Subscription, Package, ...providers]) await model.collection.deleteMany({});
  user = oid();
  pkg = await Package.create({ duration: 1, categories: [oid()], pricing: { XAF: 1000 }, isActive: true });
});

after(async () => { if (connection) await connection.close(); if (server) await server.stop(); });

async function payment(Model) {
  return Model.create({ user, package: pkg._id, amount: 1000, currency: 'XAF',
    status: 'SUCCESS', processed: false, verifiedPaymentAt: now,
    verifiedAmount: 1000, verifiedCurrency: 'XAF',
    purchaseSnapshot: capturePurchaseSnapshot(pkg, 'XAF', 1000) });
}

for (const [index, name] of ['KoraPay', 'pawaPay'].entries()) {
  test(`${name}: 30 simultaneous confirmations in real Mongo create one immutable grant`, async () => {
    const Model = providers[index], tx = await payment(Model);
    const results = await Promise.all(Array.from({ length: 30 }, async () => {
      const independentlyLoaded = await Model.findById(tx._id);
      return service.settleVerifiedPayment(independentlyLoaded);
    }));
    assert.equal(await Subscription.collection.countDocuments({}), 1);
    assert.equal(new Set(results.map(row => String(row._id))).size, 1);
    assert.equal(results.filter(row => row.$locals.mobileMoneySettlementCreated).length, 1);
    assert.equal((await Model.findById(tx._id)).processed, true);
    const indexes = await Subscription.collection.indexes();
    const settlementIndex = indexes.find(row => row.name === 'mobile_money_settlement_unique');
    assert.equal(settlementIndex.unique, true); assert.equal(settlementIndex.sparse, true);
  });
}

test('real Mongo crash after grant before transaction acknowledgement reuses exactly the same grant', async () => {
  const Model = providers[0], tx = await payment(Model), originalUpdate = Model.updateOne;
  Model.updateOne = async () => { throw new Error('simulated acknowledgement outage'); };
  try {
    await assert.rejects(service.settleVerifiedPayment(tx), /simulated acknowledgement outage/);
  } finally { Model.updateOne = originalUpdate; }
  assert.equal((await Model.findById(tx._id)).processed, false);
  const original = await Subscription.collection.findOne({});
  const recovered = await service.settleVerifiedPayment(await Model.findById(tx._id));
  assert.equal(await Subscription.collection.countDocuments({}), 1);
  assert.equal(String(recovered._id), String(original._id));
  assert.equal(recovered.endDate.getTime(), original.endDate.getTime());
  assert.equal(recovered.$locals.mobileMoneySettlementCreated, false);
});

test('pre-migration expired grant is recovered through collection lookup, never renewed', async () => {
  const Model = providers[1], tx = await payment(Model);
  const old = { _id: oid(), user, package: pkg._id, paymentReference: String(tx._id),
    paymentProvider: 'MOBILE_MONEY', status: 'expired',
    startDate: new Date('2026-10-01'), endDate: new Date('2026-10-02'),
    pricing: { amount: 1000, currency: 'XAF' }, categorySnapshot: [] };
  await Subscription.collection.insertOne(old);
  assert.equal(await Subscription.findById(old._id).where({ status: 'active' }), null);
  const sub = await service.settleVerifiedPayment(tx);
  assert.equal(String(sub._id), String(old._id)); assert.equal(sub.status, 'expired');
  assert.equal(sub.endDate.getTime(), old.endDate.getTime());
  assert.equal(await Subscription.collection.countDocuments({}), 1);
});

test('purchased terms survive package deactivation, repricing and category changes in Mongo', async () => {
  const tx = await payment(providers[0]), purchasedCategories = pkg.categories.map(String);
  await Package.updateOne({ _id: pkg._id }, { $set: {
    isActive: false, duration: 30, categories: [], 'pricing.XAF': 99999
  } });
  const sub = await service.settleVerifiedPayment(tx);
  assert.equal(sub.pricing.amount, 1000); assert.equal(sub.endDate - sub.startDate, 86400000);
  assert.deepEqual(sub.categorySnapshot.map(String), purchasedCategories);
});

test('a paid legacy transaction without a snapshot is fulfilled even if package is no longer sold', async () => {
  const tx = await payment(providers[0]); tx.purchaseSnapshot = undefined; await tx.save();
  await Package.updateOne({ _id: pkg._id }, { $set: { isActive: false, 'pricing.XAF': 2000 } });
  const sub = await service.settleVerifiedPayment(tx);
  assert.equal(sub.pricing.amount, 1000); assert.equal(await Subscription.collection.countDocuments({}), 1);
});
