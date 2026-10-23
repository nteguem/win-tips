// Explicit disposable integration test. Requires the existing test-only Mongo
// runtime path and a cached mongod; never reads application .env or starts jobs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const api = path.resolve(__dirname, '..');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) throw new Error('Explicit disposable Mongo runtime/binary required');
process.env.NODE_ENV = 'test'; process.env.APP_ID = 'wintips';
process.env.DISABLE_PUSH_NOTIFICATIONS = 'true';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const { createPlan } = require('../src/api/services/common/editorialCataloguePlan');
const { applyPlan, rollback, readState } = require('../tools/editorial-catalogue.cjs');
const { provision } = require('../tools/editorial-indexes.cjs');
const { createManagedGoogleActivation } = require('../src/api/services/common/managedGoogleActivation');
const { managedGooglePrice } = require('../src/api/services/common/packagePricing');
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
mongoose.set('autoCreate', false); mongoose.set('autoIndex', false);
const models = {};
for (const name of ['Category', 'Package', 'Subscription', 'EditorialItem', 'EditorialNotification', 'Device', 'PushDelivery']) models[name] = require(`../src/api/models/common/${name}`);
models.User = require('../src/api/models/user/User');
models.GooglePlayTransaction = require('../src/api/models/user/GooglePlayTransaction');
require('../src/api/models/common/Formation');
const { Package, Subscription, Category, EditorialItem, GooglePlayTransaction } = models;
const subscriptionService = require('../src/api/services/user/subscriptionService');
const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
const config = require('../tools/editorial-catalogue.example.json');
const clone = value => JSON.parse(JSON.stringify(value));
const oid = () => new mongoose.Types.ObjectId();
const userA = oid(), userB = oid();
let mongo, originalPlan, firstReceipt, packages;
const activation = createManagedGoogleActivation({ GooglePlayTransaction, Subscription });
const data = { purchaseState: 0, acknowledgementState: 1, purchaseTimeMillis: String(Date.now()), consumptionState: 0, orderId: 'TEST-ONLY-ORDER' };
function args(pkg, token, currency = 'EUR', userId = userA) {
  return { pkg, packageId: pkg._id, userId, purchaseToken: token, productId: pkg.googleProductId,
    price: managedGooglePrice(pkg, pkg.googleProductId, currency), data, appPackageName: 'test.only.wintips' };
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { systemBinary: process.env.WINTIPS_TEST_MONGO_BINARY },
    replSet: { count: 1, storageEngine: 'wiredTiger', spawn: { windowsHide: true } },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'] }],
  });
  const uri = mongo.getUri('wintips_catalogue_disposable');
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  // MongoDB transactions cannot implicitly create these namespaces in every
  // supported server version. Creation here is only in the disposable database.
  for (const name of ['categories', 'packages', 'subscriptions', 'googleplaytransactions', 'users', 'devices']) await mongoose.connection.db.createCollection(name);
  await GooglePlayTransaction.collection.createIndex({ purchaseToken: 1 }, { unique: true });
  await models.User.collection.insertMany([{ _id: userA, isActive: true }, { _id: userB, isActive: true }]);
}, { timeout: 180000 });
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('transactional catalogue applies once, recovers the full receipt and rolls back without deletion', async () => {
  const db = mongoose.connection.db, client = mongoose.connection.getClient();
  originalPlan = createPlan(await readState(db), config);
  assert.equal(originalPlan.operations.length, 8);
  firstReceipt = await applyPlan(db, client, originalPlan, { intent: true, confirmHash: originalPlan.planHash });
  assert.equal(firstReceipt.applied, 8);
  const replay = await applyPlan(db, client, originalPlan, { intent: true, confirmHash: originalPlan.planHash });
  assert.equal(replay.applied, 0); assert.equal(replay.recoveredAlreadyApplied, 8);
  assert.equal(replay.operations.length, 8);
  const result = await rollback(db, client, replay, { intent: true, confirmHash: replay.receiptHash });
  assert.equal(result.disabled, 8); assert.equal(result.deleted, 0);
  assert.equal(await Category.countDocuments(), 6); assert.equal(await Package.countDocuments(), 2);
  // Fresh plan explicitly reactivates the same stable target IDs.
  const next = createPlan(await readState(db), config);
  await applyPlan(db, client, next, { intent: true, confirmHash: next.planHash });
  assert.equal(await Category.countDocuments({ isActive: true }), 6);
  packages = await Package.find().sort({ duration: 1 });
  for (const pkg of packages) {
    pkg.availableOnGooglePlay = true; pkg.googleProductType = 'ONE_TIME_PRODUCT';
    pkg.googleProductId = 'TEST_ONLY_SKU_' + pkg.duration; await pkg.save();
  }
});

test('a stale seed plan rolls back its preceding write atomically', async () => {
  const db = mongoose.connection.db, state = await readState(db), changed = clone(config);
  changed.categories[0].description.fr += ' revue'; changed.categories[1].description.fr += ' revue';
  const plan = createPlan(state, changed);
  const second = plan.operations[1];
  await db.collection(second.collection).updateOne({ _id: new mongoose.Types.ObjectId(second.id) }, { $set: { icon: 'concurrent' } });
  await assert.rejects(applyPlan(db, mongoose.connection.getClient(), plan, { intent: true, confirmHash: plan.planHash }), { code: 'STALE_PLAN' });
  const first = plan.operations[0], actual = await db.collection(first.collection).findOne({ _id: new mongoose.Types.ObjectId(first.id) });
  assert.deepEqual(actual.description, first.before.description);
  await db.collection(second.collection).updateOne({ _id: new mongoose.Types.ObjectId(second.id) }, { $set: { icon: second.before.icon } });
});

test('managed Google crash between transaction and subscription leaves neither orphan, then exact retry succeeds', async () => {
  const pkg = packages[0], input = args(pkg, 'TEST_CRASH_TOKEN');
  const failingSub = { create: async () => { throw new Error('simulated Subscription write failure'); }, findById: Subscription.findById.bind(Subscription) };
  const broken = createManagedGoogleActivation({ GooglePlayTransaction, Subscription: failingSub });
  await assert.rejects(broken(input), /simulated Subscription/);
  assert.equal(await GooglePlayTransaction.countDocuments({ purchaseToken: input.purchaseToken }), 0);
  const sub = await activation(input);
  assert(sub); assert.equal(sub.pricing.amount, 5.34); assert.equal(sub.pricing.currency, 'EUR');
  assert.equal(sub.pricing.source, 'configured_catalogue_reference'); assert.equal(sub.categorySnapshot.length, 2);
  const replay = await activation(input); assert.equal(String(replay._id), String(sub._id));
  assert.equal(await Subscription.countDocuments({ googlePlayTransaction: sub.googlePlayTransaction }), 1);
});

test('same-token concurrent Google activation creates exactly one subscription and enforces binding', async () => {
  const pkg = packages[1], input = args(pkg, 'TEST_CONCURRENT_TOKEN', 'USD');
  const rows = await Promise.all(Array.from({ length: 5 }, () => activation(input)));
  assert.equal(new Set(rows.map(row => String(row._id))).size, 1);
  assert.equal(await GooglePlayTransaction.countDocuments({ purchaseToken: input.purchaseToken }), 1);
  assert.equal(await Subscription.countDocuments({ googlePlayTransaction: rows[0].googlePlayTransaction }), 1);
  assert.equal(rows[0].pricing.amount, 11.99); assert.equal(rows[0].categorySnapshot.length, 4);
  await assert.rejects(activation({ ...input, userId: userB }), /autre activation/);
  await assert.rejects(activation({ ...input, packageId: packages[0]._id }), /autre activation/);
  await assert.rejects(activation({ ...input, productId: 'TEST_OTHER_SKU' }), /autre activation/);
});

test('all four decimal reference prices persist without truncation; old orphan receipt is repaired', async () => {
  for (const [index, currency, amount] of [[0, 'EUR', 5.34], [1, 'EUR', 10.67], [0, 'USD', 6], [1, 'USD', 11.99]]) {
    const pkg = packages[index], input = args(pkg, 'TEST_PRICE_' + index + currency, currency);
    if (index === 1 && currency === 'EUR') await GooglePlayTransaction.create({ purchaseToken: input.purchaseToken, productId: input.productId, user: input.userId, package: input.packageId, status: 'ACTIVE', purchaseType: 'ONE_TIME_PRODUCT', startTime: new Date(), expiryTime: new Date(Date.now() + 14 * 86400000) });
    const sub = await activation(input);
    assert.equal(sub.pricing.amount, amount); assert.equal(sub.pricing.currency, currency);
    const tx = await GooglePlayTransaction.findById(sub.googlePlayTransaction);
    // Newly atomic receipts record micros; an old repaired receipt retains its
    // old immutable price record rather than fabricating provider evidence.
    if (tx.priceAmountMicros !== undefined) assert.equal(tx.priceAmountMicros, Math.round(amount * 1000000));
    assert.equal(String(tx.subscription), String(sub._id));
  }
});

test('actual Google HTTP controller keeps purchase currency over country query, persists cents and returns the same recap (SDK simulated)', async () => {
  const express = require('express'), request = require('supertest');
  const quiet = { log() {}, error() {}, warn() {} }, providerRequests = [], sdkData = { ...data, productId: undefined };
  const googleSdk = { google: { auth: { GoogleAuth: class {} }, androidpublisher: () => ({ purchases: { products: {
    get: async payload => { providerRequests.push(payload); return { data: sdkData }; }, consume: async () => ({}), acknowledge: async () => ({}),
  } } }) } };
  const serviceModule = { exports: {} };
  const serviceMocks = { googleapis: googleSdk, '../../models/user/GooglePlayTransaction': GooglePlayTransaction,
    '../../models/common/Subscription': Subscription, '../../models/common/Package': Package,
    '../common/packagePricing': require('../src/api/services/common/packagePricing'),
    '../common/managedGoogleActivation': require('../src/api/services/common/managedGoogleActivation') };
  vm.runInNewContext(fs.readFileSync(path.join(api, 'src/api/services/user/GooglePlayService.js'), 'utf8'), { module: serviceModule,
    require: key => { if (!(key in serviceMocks)) throw new Error(key); return serviceMocks[key]; }, console: quiet, process: { env: { GOOGLE_PLAY_PACKAGE_NAME: 'test.only.wintips' } } });
  const controllerModule = { exports: {} }, mocks = {
    '../../../utils/catchAsync': require('../src/utils/catchAsync'), '../../../utils/AppError': require('../src/utils/AppError'),
    '../../services/user/GooglePlayService': serviceModule.exports, '../../models/common/Package': Package,
    '../../services/common/packagePricing': require('../src/api/services/common/packagePricing'),
  };
  vm.runInNewContext(fs.readFileSync(path.join(api, 'src/api/controllers/user/googlePlayController.js'), 'utf8'), {
    module: controllerModule, exports: controllerModule.exports, require: key => { if (!(key in mocks)) throw new Error(key); return mocks[key]; }, console: quiet,
  });
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { _id: userA }; next(); });
  app.post('/api/google-play/validate-one-time', controllerModule.exports.validateOneTimePurchase);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: { message: error.message } }));
  const checks = [];
  for (const [index, currency, amount] of [[0, 'EUR', 5.34], [1, 'EUR', 10.67], [0, 'USD', 6], [1, 'USD', 11.99]]) {
    const pkg = packages[index], body = { purchaseToken: 'TEST_HTTP_' + index + currency, productId: pkg.googleProductId, packageId: String(pkg._id), currency };
    const response = await request(app).post('/api/google-play/validate-one-time?currency=XAF').send(body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const recap = response.body.data.subscription;
    assert.equal(recap.pricing.amount, amount); assert.equal(recap.pricing.currency, currency);
    const stored = await Subscription.findById(recap._id).lean();
    assert.equal(stored.pricing.amount, amount); assert.equal(stored.pricing.currency, currency);
    checks.push({ request: { productId: body.productId, packageId: body.packageId, currency, amountSent: false, conflictingQueryCurrency: 'XAF' },
      httpStatus: response.status, persisted: { amount: stored.pricing.amount, currency: stored.pricing.currency, source: stored.pricing.source },
      recap: { amount: recap.pricing.amount, currency: recap.pricing.currency }, passed: true });
  }
  assert.equal(providerRequests.length, 4);
  if (process.env.WINTIPS_API_EVIDENCE_OUT) {
    fs.mkdirSync(process.env.WINTIPS_API_EVIDENCE_OUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.WINTIPS_API_EVIDENCE_OUT, 'google-checkout-evidence.json'), JSON.stringify({
      simulatedGoogleSdk: true, noRealGooglePayment: true, noProductionSku: true, amountEvidence: 'configured_catalogue_reference; ProductPurchase v1 has no paid amount', checks,
    }, null, 2) + '\n');
  }
});

test('purchased rights survive future catalogue edits, preserve Essential/Premium separation and expire', async () => {
  const premium = packages[1], input = args(premium, 'TEST_SNAPSHOT_TOKEN', 'EUR', userB);
  const sub = await activation(input), ids = [...sub.categorySnapshot].map(String);
  premium.categories = premium.categories.slice(0, 2); await premium.save();
  for (const category of ids) assert.equal(await subscriptionService.hasAccessToCategory(userB, category), true);
  assert.equal((await subscriptionService.getUserSubscriptionInfo(userB)).activePackages[0].categories.length, 4);
  const audience = createEditorialNotificationRepository(models);
  assert((await audience.entitledUsers(ids[3], [userB], new Date())).includes(String(userB)));
  await Subscription.updateOne({ _id: sub._id }, { $set: { endDate: new Date(Date.now() - 1000) } });
  assert.equal(await subscriptionService.hasAccessToCategory(userB, ids[3]), false);
  premium.categories = ids; await premium.save();
});

test('managed one-time Google rights expire at the exact 7/14-day boundary in lists, detail access and push audience', async t => {
  const cases = [];
  for (const pkg of packages) {
    const user = oid();
    await models.User.collection.insertOne({ _id: user, isActive: true });
    const sub = await activation(args(pkg, 'TEST_EXACT_EXPIRY_' + pkg.duration, 'EUR', user));
    assert.equal(sub.paymentProvider, 'GOOGLE_PLAY'); assert.equal(sub.autoRenewing, false);
    assert.equal(sub.categorySnapshot.length, pkg.duration === 7 ? 2 : 4);
    assert.equal(sub.endDate.getTime() - sub.startDate.getTime(), pkg.duration * 86400000);
    cases.push({ user, sub, categories: sub.categorySnapshot.map(String) });
  }
  const audience = createEditorialNotificationRepository(models);
  // Date-only mocking leaves real network/timeouts untouched. These are the
  // actual service/model queries, including Subscription.find middleware.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    for (const { user, sub, categories } of cases) {
      for (const [offset, allowed] of [[-1, true], [0, false], [1, false]]) {
        t.mock.timers.setTime(sub.endDate.getTime() + offset);
        const rows = await subscriptionService.getActiveSubscriptions(user);
        assert.equal(rows.length, allowed ? 1 : 0, `list at expiry ${offset}ms (${categories.length} rights)`);
        const info = await subscriptionService.getUserSubscriptionInfo(user);
        assert.equal(info.hasActiveSubscription, allowed); assert.equal(info.totalActiveSubscriptions, allowed ? 1 : 0);
        for (const category of categories) assert.equal(await subscriptionService.hasAccessToCategory(user, category), allowed);
        const recipients = await audience.entitledUsers(categories[0], [user], new Date());
        assert.equal(recipients.includes(String(user)), allowed, `push audience at expiry ${offset}ms`);
      }
      const raw = await Subscription.collection.findOne({ _id: sub._id });
      assert.equal(raw.status, 'active', 'expiry is enforced without waiting for a cleanup write');
      assert.equal(raw.endDate.getTime(), sub.endDate.getTime());
      assert.deepEqual(raw.categorySnapshot.map(String), categories);
    }
  } finally { t.mock.timers.reset(); }
});

test('historical renewable Google rights keep the existing expiry/renewal policy without adding a snapshot', async t => {
  const user = oid(), packageId = oid(), subscriptionId = oid(), category = packages[0].categories[0];
  const end = new Date(Date.now() + 30 * 86400000);
  await models.User.collection.insertOne({ _id: user, isActive: true });
  // Represent a pre-existing legacy record; it must not be retrofitted by the
  // new-purchase schema hook or migrated into a managed fixed-term package.
  await Package.collection.insertOne({ _id: packageId, name: { fr: 'Legacy test', en: 'Legacy test' },
    categories: [category], duration: 30, pricing: { XAF: 10000 }, isActive: false });
  await Subscription.collection.insertOne({ _id: subscriptionId, user, package: packageId,
    startDate: new Date(), endDate: end, status: 'active', paymentProvider: 'GOOGLE_PLAY', autoRenewing: true,
    pricing: { amount: 10000, currency: 'XAF' } });
  const audience = createEditorialNotificationRepository(models);
  t.mock.timers.enable({ apis: ['Date'], now: end.getTime() - 1 });
  try {
    assert.equal((await subscriptionService.getActiveSubscriptions(user)).length, 1);
    assert.equal(await subscriptionService.hasAccessToCategory(user, String(category)), true);
    assert((await audience.entitledUsers(String(category), [user], new Date())).includes(String(user)));
    t.mock.timers.setTime(end.getTime());
    assert.equal((await subscriptionService.getActiveSubscriptions(user)).length, 0);
    assert.equal(await subscriptionService.hasAccessToCategory(user, String(category)), false);
    assert.deepEqual(await audience.entitledUsers(String(category), [user], new Date()), []);
    // Simulate the existing verified renewal job extending the same record.
    const renewedEnd = new Date(end.getTime() + 30 * 86400000);
    await Subscription.collection.updateOne({ _id: subscriptionId }, { $set: { endDate: renewedEnd } });
    assert.equal((await subscriptionService.getActiveSubscriptions(user)).length, 1);
    assert.equal(await subscriptionService.hasAccessToCategory(user, String(category)), true);
    assert((await audience.entitledUsers(String(category), [user], new Date())).includes(String(user)));
    const raw = await Subscription.collection.findOne({ _id: subscriptionId });
    assert.equal(raw.categorySnapshot, undefined); assert.equal(raw.autoRenewing, true);
    assert.equal(raw.status, 'active'); assert.equal(raw.endDate.getTime(), renewedEnd.getTime());
  } finally { t.mock.timers.reset(); }
});

test('Duo partial unique index keeps the first identity across restarts and concurrent sources', async () => {
  await provision(mongoose.connection.db, { apply: true, intent: true });
  const cat = await Category.findOne({ editorialSource: 'rdj_football_duo' });
  const repo = createEditorialRepository({ Category, EditorialItem, subscriptionService, accessGateService: {} });
  const payload = sourceId => ({ sourceId, sourceUrl: `https://www.ruedesjoueurs.com/paris-sportifs/sport-news/news-pmu-sport/${sourceId}-combine-23-10-2026.html`, kind: 'combine', legs: [1,2].map(n => ({
    startsAtUtc: '2026-10-23T18:00:00Z', teams: { home: { name: 'TestHome' + n }, away: { name: 'TestAway' + n } }, selection: { label: { fr: 'Les deux équipes marquent' }, betType: 'btts' },
  })) });
  const op = sourceId => ({ updateOne: { filter: { categoryId: cat._id, source: 'rdj_football_duo', editionDate: '2026-10-23', sourceId },
    update: { $set: { kind: 'combine', payload: payload(sourceId), contentHash: 'test', isPublished: true } }, upsert: true } });
  await repo.upsertBatch([op('111')]); await repo.upsertBatch([op('111')]);
  await assert.rejects(repo.upsertBatch([op('222')]), { statusCode: 409 });
  assert.equal(await EditorialItem.countDocuments({ categoryId: cat._id }), 1);
});

test('optional preview exports are actual HTTP responses from seeded disposable Mongo and real entitlement services', { skip: !process.env.WINTIPS_PREVIEW_INPUT || !process.env.WINTIPS_PREVIEW_OUT }, async () => {
  const express = require('express'), request = require('supertest'), crypto = require('node:crypto');
  const { createEditorialService } = require('../src/api/services/common/editorialService');
  const { createEditorialController } = require('../src/api/controllers/common/editorialController');
  const { createEditorialNotificationService } = require('../src/api/services/common/editorialNotifications');
  const input = path.resolve(process.env.WINTIPS_PREVIEW_INPUT), out = path.resolve(process.env.WINTIPS_PREVIEW_OUT);
  const requireEnglish = process.env.WINTIPS_PREVIEW_REQUIRE_EN === 'true';
  // Only this disposable QA driver accepts a historical eligibility clock.
  // Source dates remain untouched; this is never evidence of live publication.
  const requestedClock = process.env.WINTIPS_PREVIEW_CLOCK_UTC;
  const previewNow = requestedClock ? new Date(requestedClock) : new Date();
  assert(Number.isFinite(previewNow.getTime()), 'Invalid explicit preview UTC clock');
  if (requestedClock) assert.equal(previewNow.toISOString().replace('.000Z', 'Z'), requestedClock.replace('.000Z', 'Z'), 'Preview clock must be a canonical UTC timestamp');
  const fixedClock = () => previewNow;
  const sources = config.categories.map(row => row.source);
  const batches = sources.map(source => {
    const file = path.join(input, source + (requireEnglish ? '.bilingual.json' : '.json'));
    if (!fs.existsSync(file) && source === 'rdj_football_goals') return { file: null, batch: { source, editionDate: '2026-10-23', items: [] } };
    return { file, batch: JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri('wintips_catalogue_http_preview'), { autoCreate: false, autoIndex: false });
  const db = mongoose.connection.db;
  for (const name of ['categories', 'packages', 'subscriptions', 'googleplaytransactions', 'users', 'devices']) await db.createCollection(name);
  const plan = createPlan(await readState(db), config);
  await applyPlan(db, mongoose.connection.getClient(), plan, { intent: true, confirmHash: plan.planHash });
  await provision(db, { apply: true, intent: true });
  const essential = await Package.findOne({ duration: 7 }), premium = await Package.findOne({ duration: 14 });
  const demo = { free: oid(), essential: oid(), premium: oid() };
  await models.User.collection.insertMany(Object.values(demo).map(_id => ({ _id, isActive: true })));
  for (const [name, pkg] of [['essential', essential], ['premium', premium]]) {
    // The payment acknowledgement is simulated; actual subscription creation
    // computes the purchased 7/14-day duration and captures the real rights.
    const sub = await subscriptionService.createSubscription(demo[name], pkg._id, 'XAF', 'TEST_ONLY_SIMULATED_PAYMENT');
    assert.equal(sub.endDate.getTime() - sub.startDate.getTime(), pkg.duration * 86400000);
    assert.equal(sub.categorySnapshot.length, pkg.categories.length);
  }
  for (const [name, user] of Object.entries(demo)) for (const language of ['fr', 'en']) await models.Device.collection.insertOne({
    deviceId: 'TEST_ONLY_' + name + '_' + language, user, platform: 'android', language, deviceLanguage: language,
    fcmToken: 'TEST_ONLY_NOT_A_REAL_FCM_TOKEN_' + name + language, editorialSchemaVersion: 1, notificationsEnabled: true, isActive: true, pushProvider: 'fcm',
  });
  const repository = createEditorialRepository({ Category, EditorialItem, subscriptionService, accessGateService: require('../src/api/services/common/accessGateService') });
  const providerCalls = [];
  const notificationService = createEditorialNotificationService({ repository: createEditorialNotificationRepository(models), clock: fixedClock,
    appId: () => 'wintips', enabled: () => true, importEnabled: () => true, globallyDisabled: () => false, requireEnglish: () => requireEnglish,
    push: async (appId, notification, options) => {
      let accepted = 0;
      for (const deviceId of options.targeting.deviceIds) {
        const result = await models.PushDelivery.collection.updateOne({ msgId: notification.id + ':' + deviceId }, { $setOnInsert: {
          appId, notificationId: notification.id, deviceId, msgId: notification.id + ':' + deviceId, status: 'sent', attempts: 1,
        } }, { upsert: true });
        accepted += result.upsertedCount;
      }
      providerCalls.push({ sourceNotification: notification.id, language: notification.extra.language, categoryId: notification.extra.categoryId,
        recipients: options.targeting.deviceIds.length, accepted, simulated: true });
      return { fcm: accepted, onesignal: 0 };
    },
  });
  const service = createEditorialService({ repository, clock: fixedClock, importEnabled: () => true, requireEnglish: () => requireEnglish,
    notifications: notificationService });
  const controller = createEditorialController(service), packagesController = require('../src/api/controllers/user/packageController');
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { if (req.headers['x-test-user']) req.user = { _id: req.headers['x-test-user'] }; next(); });
  app.get('/api/editorial/feed', controller.feed); app.get('/api/editorial/items/:id/analysis', controller.analysis);
  process.env.WINTIPS_EDITORIAL_WORKER_TOKEN = 'TEST_ONLY_LOCAL_WORKER_TOKEN_1234567890';
  app.post('/api/internal/editorial/import', require('../src/api/middlewares/common/editorialWorkerAuth'), controller.importBatch);
  app.get('/api/packages', packagesController.getAvailablePackages);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ success: false, error: { message: error.message } }));
  const imported = [];
  for (const entry of batches) {
    if (!entry.batch.items.length) continue;
    const response = await request(app).post('/api/internal/editorial/import').set('authorization', 'Bearer ' + process.env.WINTIPS_EDITORIAL_WORKER_TOKEN).send(entry.batch);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    imported.push({ source: entry.batch.source, count: entry.batch.items.length, file: entry.file,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex') });
  }
  const beforeReplay = await models.PushDelivery.countDocuments();
  const replay = await service.drainNotifications({ dryRun: false });
  assert.equal(replay.sent, 0); assert.equal(await models.PushDelivery.countDocuments(), beforeReplay);
  fs.mkdirSync(out, { recursive: true }); const files = {}, analyses = [], outputHashes = {}, permissionChecks = [], httpChecks = [];
  const save = (name, value) => { const body = JSON.stringify(value, null, 2) + '\n'; fs.writeFileSync(path.join(out, name), body, 'utf8'); outputHashes[name] = crypto.createHash('sha256').update(body).digest('hex'); return name; };
  const anonymousFeed = await request(app).get('/api/editorial/feed?isVip=true');
  assert.equal(anonymousFeed.status, 401);
  httpChecks.push({ label: 'VIP feed anonymous', method: 'GET', route: '/api/editorial/feed?isVip=true', status: anonymousFeed.status, expected: 401, passed: true });
  for (const language of ['fr', 'en']) {
    if (language === 'en' && !requireEnglish) continue;
    for (const [view, user] of [['free', demo.free], ['vip-essential', demo.essential], ['vip-premium', demo.premium]]) {
      const response = await request(app).get('/api/editorial/feed').query({ isVip: view === 'free' ? 'false' : 'true', lang: language, date: '2026-10-23' }).set('x-test-user', String(user));
      assert.equal(response.status, 200); files[view + '-' + language] = save(view + '-' + language + '.json', response.body);
      if (view === 'vip-essential') {
        assert.equal(response.body.data.categories.filter(cat => !cat.locked).length, 2);
        for (const cat of response.body.data.categories.filter(cat => cat.locked)) for (const item of cat.items) { assert.equal(item.summary, undefined); assert.equal(item.selection, undefined); }
      }
      if (view === 'vip-premium') assert.equal(response.body.data.categories.filter(cat => !cat.locked).length, 4);
    }
  }
  for (const currency of ['XAF', 'EUR', 'USD']) {
    const response = await request(app).get('/api/packages').query({ currency, lang: 'fr' });
    assert.equal(response.status, 200); assert.equal(response.body.data.packages.length, currency === 'XAF' ? 2 : 0);
    files['packages-' + currency] = save('packages-' + currency + '.json', response.body);
  }
  if (requireEnglish) {
    const response = await request(app).get('/api/packages').query({ currency: 'XAF', lang: 'en' });
    assert.equal(response.status, 200); assert.equal(response.body.data.packages.length, 2);
    assert(response.body.data.packages.some(pkg => pkg.name === 'Essential'));
    files['packages-XAF-en'] = save('packages-XAF-en.json', response.body);
  }
  for (const item of await EditorialItem.find().sort({ source: 1, sourceId: 1 }).lean()) {
    const entry = { id: String(item._id), source: item.source, sourceId: item.sourceId, editionDate: item.editionDate, frPath: null, enPath: null };
    const category = await Category.findById(item.categoryId).lean();
    const anonymous = await request(app).get('/api/editorial/items/' + item._id + '/analysis?lang=fr');
    const freeDetail = await request(app).get('/api/editorial/items/' + item._id + '/analysis?lang=fr').set('x-test-user', String(demo.free));
    const essentialDetail = await request(app).get('/api/editorial/items/' + item._id + '/analysis?lang=fr').set('x-test-user', String(demo.essential));
    const expectedEssential = !category.isVip || essential.categories.some(cat => String(cat) === String(category._id)) ? 200 : 403;
    assert.equal(anonymous.status, category.isVip ? 401 : 200); assert.equal(essentialDetail.status, expectedEssential);
    assert.equal(freeDetail.status, category.isVip ? 403 : 200);
    if (expectedEssential === 403) { assert.equal(essentialDetail.body.data, undefined); assert.equal(essentialDetail.body.error.code, 'SUBSCRIPTION_REQUIRED'); }
    permissionChecks.push({ id: String(item._id), source: item.source, anonymous: anonymous.status, essential: essentialDetail.status, premium: 200 });
    for (const [profile, response, expected] of [['anonymous', anonymous, category.isVip ? 401 : 200], ['free', freeDetail, category.isVip ? 403 : 200], ['essential', essentialDetail, expectedEssential]]) httpChecks.push({
      label: item.source + ' detail ' + profile, method: 'GET', route: '/api/editorial/items/' + item._id + '/analysis?lang=fr', status: response.status, expected, passed: response.status === expected,
    });
    for (const language of ['fr', 'en']) {
      if (language === 'en' && !requireEnglish) continue;
      const response = await request(app).get('/api/editorial/items/' + item._id + '/analysis').query({ lang: language }).set('x-test-user', String(demo.premium));
      assert.equal(response.status, 200); entry[language + 'Path'] = save('analysis-' + item._id + '-' + language + '.json', response.body);
      httpChecks.push({ label: item.source + ' detail premium ' + language, method: 'GET', route: '/api/editorial/items/' + item._id + '/analysis?lang=' + language, status: response.status, expected: 200, passed: response.status === 200 });
      if (requireEnglish) assert.equal(response.body.data.contentLanguage, language);
    }
    analyses.push(entry);
  }
  assert.equal(analyses.length, imported.reduce((sum, row) => sum + row.count, 0));
  files.permissions = save('permissions.json', { success: true, data: { simulatedAccountAuthentication: true, checks: permissionChecks } });
  const generatedAtUtc = new Date().toISOString();
  const manifest = { date: '2026-10-23', generatedAtUtc, evidence: 'Real Express controllers + actual Mongoose schemas, seed/import and entitlement services; disposable local MongoDB replica set',
    simulated: { database: true, accountAuthentication: true, accountIds: Object.fromEntries(Object.entries(demo).map(([key, id]) => [key, String(id)])),
      pushProvider: true, payments: true, googlePlay: true, googleSkuConfigured: false, clock: Boolean(requestedClock) },
    english: requireEnglish ? 'complete_real_worker_batches_imported' : 'pending_not_exported', requireEnglishDuringImport: requireEnglish,
    clock: previewNow.toISOString(), clockMode: requestedClock ? 'qa_snapshot' : 'wall_clock',
    clockContext: { snapshotAtUtc: previewNow.toISOString(), generatedAtUtc, livePublicationEvidence: false,
      sourceDatesUnmodified: true, scope: 'editorial import/feed/notification simulation only; not a live publication or delivery proof' },
    imported, totalItems: analyses.length, files, analyses, outputHashes, httpChecks,
    notifications: { simulated: true, accepted: beforeReplay, replayAdditionalAccepted: replay.sent, providerCalls },
    noProductionMutation: true, noRealNotification: true, noGooglePayment: true };
  save('manifest.json', manifest);
});
