// Opt-in disposable replica-set tests; never loads .env, jobs or a real provider.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) throw new Error('Explicit disposable Mongo runtime/binary required');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const { hash } = require('../tools/google-play-products.cjs');
const { EXPECTED, CATEGORIES, euroMoney, googleProof, readState, makePlan, applyPlan, rollback } = require('../tools/google-play-bindings.cjs');
const oid = value => new mongoose.Types.ObjectId(value);
const euroPrices = ['9.99', '20.99'];
let server, connection, db, client;
const historicalCollections = ['subscriptions', 'googleplaytransactions', 'tickets', 'predictions'];
const encoded = value => mongoose.mongo.BSON.EJSON.serialize(value, { relaxed: true });
let providerProducts, providerCalls;
function product(spec, euro) {
  return { packageName: 'com.wintips.application', productId: spec.id, listings: structuredClone(spec.listings),
    purchaseOptions: [{ purchaseOptionId: 'buy', state: 'ACTIVE', buyOption: { legacyCompatible: true, multiQuantityEnabled: false },
      regionalPricingAndAvailabilityConfigs: [
        { regionCode: 'US', availability: 'AVAILABLE', price: { currencyCode: 'USD', units: spec.usd, nanos: 0 } },
        { regionCode: 'FR', availability: 'AVAILABLE', price: euroMoney(euro) },
        { regionCode: 'BE', availability: 'AVAILABLE', price: { currencyCode: 'EUR', units: '99', nanos: 0 } },
      ] }],
  };
}
async function request(config) {
  providerCalls.push(config); assert.equal(config.method, 'GET');
  const value = providerProducts.find(row => config.url.endsWith('/' + row.productId));
  if (!value) throw { response: { status: 404 } };
  return { status: 200, data: structuredClone(value) };
}
async function plan() {
  return makePlan(await readState(db), await googleProof({ request, eurPrices: euroPrices }), euroPrices);
}
async function historicalHashes() {
  return Object.fromEntries(await Promise.all(historicalCollections.map(async name => [name, hash(encoded(await db.collection(name).find({}).sort({ _id: 1 }).toArray()))])));
}
before(async () => {
  server = await MongoMemoryReplSet.create({ binary: { systemBinary: process.env.WINTIPS_TEST_MONGO_BINARY },
    replSet: { count: 1, storageEngine: 'wiredTiger', spawn: { windowsHide: true } },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'] }] });
  const uri = server.getUri('wintips_play_bindings_disposable'); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  connection = await mongoose.createConnection(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  db = connection.db; client = connection.getClient(); assert.equal(db.databaseName, 'wintips_play_bindings_disposable');
  for (const name of ['packages', 'categories', ...historicalCollections]) await db.createCollection(name);
}, { timeout: 180000 });
beforeEach(async () => {
  assert.equal(db.databaseName, 'wintips_play_bindings_disposable');
  for (const name of ['packages', 'categories', ...historicalCollections]) await db.collection(name).deleteMany({});
  await db.collection('categories').insertMany(CATEGORIES.map(row => ({ _id: oid(row.id), name: row.name, editorialSource: row.source, isVip: true, isActive: true })));
  await db.collection('packages').insertMany(EXPECTED.map(spec => ({ _id: oid(spec.packageId), catalogueKey: 'wintips-rdj-catalogue-v1:package:' + spec.key,
    name: { fr: spec.key, en: spec.key }, categories: spec.categories.map(oid), duration: spec.days, createdAt: new Date('2026-10-23T21:00:00Z'),
    isActive: true, paymentMode: 'money', availableOnGooglePlay: false, googleProductId: null, googleProductType: null,
    pricing: { XAF: spec.cfa, XOF: spec.cfa, USD: spec.oldUsd, EUR: spec.oldEur }, pricingProvenance: { XAF: { kind: 'owner_explicit' }, XOF: { kind: 'owner_explicit' }, approval: 'existing' },
  })).concat({ _id: oid('a'.repeat(24)), name: { fr: 'Legacy commercial offer' }, duration: 30, categories: [], isActive: false, pricing: { USD: 21 }, googleProductId: 'EXISTING_OLD_SKU' }));
  for (const name of historicalCollections) await db.collection(name).insertOne({ _id: oid(), marker: 'TEST_ONLY_HISTORY_NEVER_IN_RECEIPT', purchaseToken: 'TEST_ONLY_TOKEN_NEVER_IN_RECEIPT', user: 'TEST_ONLY_CUSTOMER_NEVER_IN_RECEIPT' });
  providerProducts = EXPECTED.map((spec, i) => product(spec, euroPrices[i])); providerCalls = [];
});
after(async () => { if (connection) await connection.close(); if (server) await server.stop(); });

test('transactional two-package binding replays exactly and rollback preserves all historical and newly purchased rights', async () => {
  const original = await readState(db), originalHash = hash(original), history = await historicalHashes(), p = await plan();
  const receipt = await applyPlan({ db, client, request, plan: p, confirmedHash: p.planHash, intent: true });
  assert.equal(receipt.applied, 2); assert.equal(receipt.skipped, 0);
  const changed = await readState(db);
  assert.equal(changed.packages.filter(row => row.availableOnGooglePlay === true).length, 2);
  assert.deepEqual(await historicalHashes(), history);
  const again = await applyPlan({ db, client, request, plan: p, confirmedHash: p.planHash, intent: true });
  assert.equal(again.applied, 0); assert.equal(again.skipped, 2); assert.deepEqual(again.operations, receipt.operations);
  assert.equal(JSON.stringify(receipt).includes('TEST_ONLY_'), false);
  await db.collection('subscriptions').insertOne({ _id: oid(), package: oid(EXPECTED[0].packageId), categorySnapshot: EXPECTED[0].categories.map(oid), endDate: new Date('2026-11-01'), marker: 'NEW_TEST_PURCHASE_KEEPS_RIGHTS' });
  const withNewPurchase = await historicalHashes();
  const reverted = await rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true });
  assert.equal(reverted.restored, 2); assert.equal(hash(await readState(db)), originalHash); assert.deepEqual(await historicalHashes(), withNewPurchase);
  assert.equal((await rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true })).skipped, 2);
  assert.ok(providerCalls.every(row => row.method === 'GET'));
});

test('a second-package CAS drift aborts the earlier first-package update atomically', async () => {
  const p = await plan(); await db.collection('packages').updateOne({ _id: oid(EXPECTED[1].packageId) }, { $set: { 'pricing.XOF': 7001 } });
  const immediatelyBefore = hash(await readState(db));
  await assert.rejects(applyPlan({ db, client, request, plan: p, confirmedHash: p.planHash, intent: true }), /STALE_BINDING_PLAN/);
  assert.equal(hash(await readState(db)), immediatelyBefore);
  assert.equal((await db.collection('packages').findOne({ _id: oid(EXPECTED[0].packageId) })).availableOnGooglePlay, false);
});

test('Google deactivation, wrong reference price or changed category name prevents all binding writes', async () => {
  for (const mutate of [
    async () => { providerProducts[0].purchaseOptions[0].state = 'INACTIVE'; },
    async () => { providerProducts[1].purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0].price.units = '22'; },
    async () => { await db.collection('categories').updateOne({ _id: oid(CATEGORIES[0].id) }, { $set: { 'name.fr': 'Renamed during review' } }); },
  ]) {
    providerProducts = EXPECTED.map((spec, i) => product(spec, euroPrices[i]));
    await db.collection('categories').updateOne({ _id: oid(CATEGORIES[0].id) }, { $set: { name: CATEGORIES[0].name } });
    const p = await plan(), beforePackages = hash((await readState(db)).packages); await mutate();
    await assert.rejects(applyPlan({ db, client, request, plan: p, confirmedHash: p.planHash, intent: true }));
    assert.equal(hash((await readState(db)).packages), beforePackages);
  }
});

test('concurrent application of the same plan commits two bindings once and preserves private original snapshots', async () => {
  const p = await plan(), results = await Promise.all([1, 2].map(() => applyPlan({ db, client, request, plan: p, confirmedHash: p.planHash, intent: true })));
  assert.equal(results.reduce((sum, row) => sum + row.applied, 0), 2); assert.equal(results.reduce((sum, row) => sum + row.skipped, 0), 2);
  assert.equal(await db.collection('packages').countDocuments({}), 3); assert.deepEqual(results[0].operations, results[1].operations);
});

test('rollback refuses catalogue drift without altering either package or any purchase history', async () => {
  const p = await plan(), receipt = await applyPlan({ db, client, request, plan: p, confirmedHash: p.planHash, intent: true });
  await db.collection('packages').updateOne({ _id: oid(EXPECTED[1].packageId) }, { $set: { name: { fr: 'Edited independently' } } });
  const before = hash(await readState(db)), history = await historicalHashes();
  await assert.rejects(rollback({ db, client, receipt, confirmedHash: receipt.receiptHash, intent: true }), /STALE_BINDING_ROLLBACK/);
  assert.equal(hash(await readState(db)), before); assert.deepEqual(await historicalHashes(), history);
});
