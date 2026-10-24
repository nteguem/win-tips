// Opt-in isolated replica set only. Never loads .env/bootstrap or a provider.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) throw new Error('Explicit disposable Mongo runtime/binary required');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const tool = require('../tools/package-currency-prices.cjs');
const raw = fs.readFileSync(path.join(__dirname, 'fixtures/xaf-exchange-reference-20261024.json'));
const clock = () => new Date('2026-10-24T08:00:00Z');
const oid = value => new mongoose.Types.ObjectId(value);
const encode = value => mongoose.mongo.BSON.EJSON.serialize(value, { relaxed: true });
const historyNames = ['subscriptions', 'googleplaytransactions', 'tickets', 'predictions', 'categories', 'editorialitems', 'pushdeliveries'];
let server, connection, db, client;
function documents() {
  return tool.SPECS.map(s => ({ _id: oid(s.id), catalogueKey: 'wintips-rdj-catalogue-v1:package:' + s.key,
    name: { fr: s.name, en: s.name }, description: { fr: 'FR preserved', en: 'EN preserved' },
    isActive: true, paymentMode: 'money', duration: s.days, categories: s.categories.map(oid),
    googleProductId: s.sku, googleProductType: 'ONE_TIME_PRODUCT', availableOnGooglePlay: true,
    pricing: { XAF: s.cfa, XOF: s.cfa, USD: s.usd, EUR: s.eur },
    pricingProvenance: { owner: 'preserved', googlePlayBinding: { actualChargeVerified: false } },
    createdAt: new Date('2026-10-23T20:00:00Z'), __v: 0,
  })).concat(Array.from({ length: 6 }, (_, i) => ({ _id: oid(String(i + 1).repeat(24)),
    isActive: false, name: { fr: 'OLD_TEST_OFFER_' + i }, pricing: { XAF: 2500 + i, CDF: 12500 + i },
    googleProductId: 'OLD_TEST_SKU_' + i, categories: [], duration: 30 })));
}
async function plan() { return tool.makePlan(await tool.readState(db), raw, { now: clock }); }
async function history() { return Object.fromEntries(await Promise.all(historyNames.map(async name => [name, tool.hash(encode(await db.collection(name).find({}).sort({ _id: 1 }).toArray()))]))); }
const apply = p => tool.applyPlan({ db, client, plan: p, confirmedHash: p.planHash, intent: true, now: clock });
before(async () => {
  server = await MongoMemoryReplSet.create({ binary: { systemBinary: process.env.WINTIPS_TEST_MONGO_BINARY },
    replSet: { count: 1, storageEngine: 'wiredTiger', spawn: { windowsHide: true } },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'] }] });
  const uri = server.getUri('wintips'); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  // The exact production database NAME is deliberately required by the tool;
  // the connection is exclusively this new ephemeral local server instance.
  connection = await mongoose.createConnection(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  db = connection.db; client = connection.getClient(); assert.equal(db.databaseName, 'wintips');
  for (const name of ['packages', ...historyNames]) await db.createCollection(name);
}, { timeout: 180000 });
beforeEach(async () => {
  assert.equal(db.databaseName, 'wintips'); assert.equal(connection.host, '127.0.0.1');
  for (const name of ['packages', ...historyNames]) await db.collection(name).deleteMany({});
  await db.collection('packages').insertMany(documents());
  for (const name of historyNames) await db.collection(name).insertOne({ marker: 'TEST_ONLY_HISTORY', user: 'TEST_ONLY_USER', token: 'TEST_ONLY_TOKEN', createdAt: new Date('2026-10-23T20:00:00Z') });
});
after(async () => { if (connection) await connection.close(); if (server) await server.stop(); });

test('two price updates, exact idempotent replay, private original backup and rollback leave all histories and old packages intact', async () => {
  const original = tool.hash(await tool.readState(db)), protectedHistory = await history(), p = await plan();
  const receipt = await apply(p); assert.equal(receipt.applied, 2); assert.equal(receipt.skipped, 0);
  assert.deepEqual(await history(), protectedHistory);
  const changed = await tool.readState(db); assert.equal(changed.packages.length, 8);
  for (const op of p.operations) assert.equal(tool.hash(changed.packages.find(row => row._id.$oid === op.id)), op.afterHash);
  const replay = await apply(p); assert.equal(replay.applied, 0); assert.equal(replay.skipped, 2);
  assert.deepEqual(replay.plan, p); assert.equal(replay.plan.operations[0].before.pricing.CDF, undefined);
  assert.equal(JSON.stringify(replay).includes('TEST_ONLY_USER'), false); assert.equal(JSON.stringify(replay).includes('TEST_ONLY_TOKEN'), false);
  await db.collection('subscriptions').insertOne({ package: oid(tool.SPECS[1].id), categorySnapshot: tool.SPECS[1].categories.map(oid), endDate: new Date('2026-11-07T00:00:00Z'), marker: 'NEW_TEST_PURCHASE' });
  const historyAfterPurchase = await history();
  const reverted = await tool.rollback({ db, client, receipt: replay, confirmedHash: replay.receiptHash, intent: true });
  assert.equal(reverted.restored, 2); assert.equal(tool.hash(await tool.readState(db)), original);
  assert.deepEqual(await history(), historyAfterPurchase);
  assert.equal((await tool.rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true })).skipped, 2);
});

test('second-target drift rolls back the first update atomically', async () => {
  const p = await plan(); await db.collection('packages').updateOne({ _id: oid(tool.SPECS[1].id) }, { $set: { 'pricing.USD': 22 } });
  const before = tool.hash(await tool.readState(db)); await assert.rejects(apply(p), /STALE_PRICE_PLAN/);
  assert.equal(tool.hash(await tool.readState(db)), before);
  assert.equal((await db.collection('packages').findOne({ _id: oid(tool.SPECS[0].id) })).pricing.CDF, undefined);
});

test('a protected old-package edit or unexpected package creation blocks all writes', async () => {
  const p = await plan(); await db.collection('packages').updateOne({ _id: oid('1'.repeat(24)) }, { $set: { duration: 99 } });
  const before = tool.hash(await tool.readState(db)); await assert.rejects(apply(p), /OTHER_PACKAGE_DRIFT/);
  assert.equal(tool.hash(await tool.readState(db)), before);
});

test('concurrent applications commit exactly two package writes and both retain the same original snapshots', async () => {
  const p = await plan(), results = await Promise.all([apply(p), apply(p)]);
  assert.equal(results.reduce((sum, r) => sum + r.applied, 0), 2);
  assert.equal(results.reduce((sum, r) => sum + r.skipped, 0), 2);
  assert.deepEqual(results[0].plan, results[1].plan); assert.equal(await db.collection('packages').countDocuments({}), 8);
});

test('a rollback drift aborts all restoration and preserves new payments and prices', async () => {
  const receipt = await apply(await plan()); await db.collection('packages').updateOne({ _id: oid(tool.SPECS[0].id) }, { $set: { 'pricing.CDF': 20000 } });
  const before = tool.hash(await tool.readState(db)), protectedHistory = await history();
  await assert.rejects(tool.rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true }), /STALE_PRICE_ROLLBACK/);
  assert.equal(tool.hash(await tool.readState(db)), before); assert.deepEqual(await history(), protectedHistory);
});

test('existing explicit missing-list currencies are kept and absent provenance is restored exactly', async () => {
  await db.collection('packages').updateOne({ _id: oid(tool.SPECS[0].id) }, { $set: { 'pricing.CDF': 20000 }, $unset: { pricingProvenance: '' } });
  const original = tool.hash(await tool.readState(db)), p = await plan(); assert.equal(p.operations[0].addedCurrencies.length, 14);
  const receipt = await apply(p); assert.equal((await db.collection('packages').findOne({ _id: oid(tool.SPECS[0].id) })).pricing.CDF, 20000);
  await tool.rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true });
  assert.equal(tool.hash(await tool.readState(db)), original);
});

test('an already-complete fresh plan has zero writes and still supplies exact backup/rollback identities', async () => {
  await apply(await plan()); const complete = await plan(); assert.ok(complete.operations.every(op => op.addedCurrencies.length === 0));
  const receipt = await apply(complete); assert.equal(receipt.applied, 0); assert.equal(receipt.skipped, 2);
  assert.equal((await tool.rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true })).restored, 0);
});
