// Explicit standalone Mongo + HTTP integration. No .env, production app,
// account, collector, provider, publication or push is loaded by these tests.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) throw new Error('Explicit disposable cached Mongo runtime/binary required');
process.env.NODE_ENV = 'test'; process.env.DISABLE_PUSH_NOTIFICATIONS = 'true';
process.env.JWT_USER_SECRET = 'standalone-openings-disposable-test-secret';
const mongoose = require('mongoose'); mongoose.set('autoCreate', false); mongoose.set('autoIndex', false);
const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const { provision } = require('../tools/editorial-indexes.cjs');
const { OPENING_IDENTITY_INDEX } = require('../src/api/services/common/editorialIndexIdentity');
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createEditorialController } = require('../src/api/controllers/common/editorialController');
const { createOpeningStorage } = require('../src/api/services/common/editorialOpeningStorage');
const Category = require('../src/api/models/common/Category'), EditorialItem = require('../src/api/models/common/EditorialItem');
const EditorialReview = require('../src/api/models/common/EditorialReview'), User = require('../src/api/models/user/User');
const auth = require('../src/api/middlewares/user/userAuth');
const date = '2026-10-25', archive = '2026-10-24';
const free = new mongoose.Types.ObjectId(), vip = new mongoose.Types.ObjectId(), gated = new mongoose.Types.ObjectId();
const reader = new mongoose.Types.ObjectId(), otherReader = new mongoose.Types.ObjectId();
const admitted = new Set(), unlocked = new Set(), subscribed = new Set();
let mongo, uri, service, app;
const token = user => jwt.sign({ id: String(user), type: 'user' }, process.env.JWT_USER_SECRET, { expiresIn: '10m' });
const endpoint = (cat = free, day = date) => `/api/editorial/categories/${cat}/editions/${day}`;
const receipts = () => mongoose.connection.db.collection('editorialopenings');
async function seed(categoryId, source, editionDate = date) {
  const payload = { source, editionDate, sourceId: String(categoryId), kind: 'match',
    title: { fr: 'Alpha contre Bravo', en: 'Alpha against Bravo' }, teams: { home: { name: 'Alpha' }, away: { name: 'Bravo' } },
    startsAtUtc: editionDate + 'T19:00:00Z', sport: { key: 'football', name: 'Football' }, competition: { name: 'League' }, status: 'upcoming',
    analysis: { fr: [{ heading: 'Analyse', paragraphs: ['Texte réservé.'] }], en: [{ heading: 'Analysis', paragraphs: ['Private text.'] }] },
    selection: { label: { fr: 'Alpha ou nul', en: 'Alpha or draw' }, odds: 1.5 } };
  await EditorialItem.collection.insertOne({ categoryId, source, editionDate, sourceId: String(categoryId), payload, isPublished: true,
    kind: 'match', startsAtUtc: new Date(payload.startsAtUtc), contentHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
}
before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { systemBinary: process.env.WINTIPS_TEST_MONGO_BINARY },
    instance: { ip: '127.0.0.1', dbName: 'wintips_openings_standalone', args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
    spawn: { windowsHide: true } });
  uri = mongo.getUri(); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  // Backward-compatible reads must not provision storage behind the operator.
  const uninitialized = createOpeningStorage(EditorialItem);
  assert.deepEqual(await uninitialized.counts([free], date), []);
  await assert.rejects(uninitialized.record(free, date, crypto.randomUUID(), new Date()), { statusCode: 503 });
  assert.equal(await mongoose.connection.db.listCollections({ name: 'editorialopenings' }).hasNext(), false);
  await provision(mongoose.connection.db, { apply: true, intent: true });
  await mongoose.connection.db.createCollection('users'); await mongoose.connection.db.createCollection('categories');
  await User.collection.insertMany([{ _id: reader, isActive: true }, { _id: otherReader, isActive: true }]);
  await Category.collection.insertMany([
    { _id: free, isActive: true, isVip: false, editorialSource: 'rdj_petit_journal', name: { fr: 'Journal', en: 'Journal' } },
    { _id: gated, isActive: true, isVip: false, editorialSource: 'rdj_petit_journal', accessGate: { type: 'ad_reward' }, name: { fr: 'Gated', en: 'Gated' } },
    { _id: vip, isActive: true, isVip: true, editorialSource: 'rdj_football_analysis', name: { fr: 'Expert', en: 'Expert' } },
  ]);
  for (const [cat, source] of [[free, 'rdj_petit_journal'], [gated, 'rdj_petit_journal'], [vip, 'rdj_football_analysis']]) await seed(cat, source);
  await seed(free, 'rdj_petit_journal', archive);
  const repository = createEditorialRepository({ Category, EditorialItem, EditorialReview,
    subscriptionService: { hasAccessToCategory: async (userId, cat) => admitted.has(`${userId}:${cat}`),
      getActiveSubscriptions: async userId => subscribed.has(String(userId)) ? [{ package: { _id: 'fixture' } }] : [] },
    accessGateService: { getCategoryGateState: async (userId, cat, { isSubscriber }) => ({ gated: !!cat.accessGate && !isSubscriber,
      locked: !!cat.accessGate && !isSubscriber && !unlocked.has(String(userId)), offers: [], state: null, unlockCount: 0 }) } });
  service = createEditorialService({ repository, clock: () => new Date(date + 'T09:00:00Z') });
  const controller = createEditorialController(service), filename = path.resolve(__dirname, '../src/api/routes/common/editorialRoutes.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: key => ({ express,
    '../../middlewares/user/userAuth': auth, '../../controllers/common/editorialController': controller })[key] }, { filename });
  app = express(); app.use(express.json()); app.use('/api/editorial', module.exports);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ success: false }));
}, { timeout: 120000 });
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('GET preview, detail, content and reviews never count an opening', async () => {
  for (const url of ['/api/editorial/library', endpoint(), endpoint() + '/content', endpoint() + '/reviews']) {
    assert.equal((await request(app).get(url)).status, 200);
  }
  assert.equal(await receipts().countDocuments(), 0);
  assert.equal((await request(app).get(endpoint())).body.data.openingCount, 0);
});

const repeated = crypto.randomUUID();
test('twenty concurrent authorized retries of one action persist exactly one receipt on standalone Mongo', async () => {
  const replies = await Promise.all(Array.from({ length: 20 }, () => request(app).post(endpoint() + '/open').send({ openingId: repeated })));
  for (const reply of replies) { assert.equal(reply.status, 200); assert.equal(reply.headers['cache-control'], 'private, no-store'); }
  assert.equal(replies.filter(reply => reply.body.data.counted).length, 1);
  assert.equal(await receipts().countDocuments({ categoryId: free, editionDate: date }), 1);
  assert.equal((await request(app).get(endpoint())).body.data.openingCount, 1);
});

test('twenty distinct opening actions increase the shared edition count without lost updates', async () => {
  const replies = await Promise.all(Array.from({ length: 20 }, () => request(app).post(endpoint() + '/open').send({ openingId: crypto.randomUUID() })));
  for (const reply of replies) { assert.equal(reply.status, 200); assert.equal(reply.body.data.counted, true); }
  assert.equal(await receipts().countDocuments({ categoryId: free, editionDate: date }), 21);
  const list = await request(app).get('/api/editorial/library?lang=en');
  assert.equal(list.body.data.categories.find(row => row.id === String(free)).openingCount, 21);
});

test('a post-commit HTTP retry is idempotent while the same UUID has independent category/date scopes', async () => {
  const retry = await request(app).post(endpoint() + '/open').send({ openingId: repeated.toUpperCase() });
  assert.equal(retry.status, 200); assert.equal(retry.body.data.counted, false); assert.equal(retry.body.data.openingCount, 21);
  assert.deepEqual(Object.keys(retry.body.data).sort(), ['categoryId', 'counted', 'editionDate', 'openingCount']);
  assert.equal((await request(app).post(endpoint(free, archive) + '/open').send({ openingId: repeated })).body.data.openingCount, 1);
  admitted.add(`${reader}:${vip}`);
  const other = await request(app).post(endpoint(vip) + '/open').set('Authorization', 'Bearer ' + token(reader)).send({ openingId: repeated });
  assert.equal(other.status, 200); assert.equal(other.body.data.openingCount, 1);
});

test('VIP and rewarded free denials do not count; current grants enable only the permitted edition', async () => {
  const uuid = crypto.randomUUID(), beforeCount = await receipts().countDocuments();
  assert.equal((await request(app).post(endpoint(vip) + '/open').send({ openingId: uuid })).status, 401);
  assert.equal((await request(app).post(endpoint(vip) + '/open').set('Authorization', 'Bearer ' + token(otherReader)).send({ openingId: uuid })).status, 403);
  assert.equal((await request(app).post(endpoint(gated) + '/open').send({ openingId: uuid })).status, 401);
  assert.equal((await request(app).post(endpoint(gated) + '/open').set('Authorization', 'Bearer ' + token(reader)).send({ openingId: uuid })).status, 403);
  assert.equal(await receipts().countDocuments(), beforeCount);
  unlocked.add(String(reader));
  assert.equal((await request(app).post(endpoint(gated) + '/open').set('Authorization', 'Bearer ' + token(reader)).send({ openingId: uuid })).body.data.counted, true);
  unlocked.clear(); subscribed.add(String(reader));
  assert.equal((await request(app).post(endpoint(gated) + '/open').set('Authorization', 'Bearer ' + token(reader)).send({ openingId: crypto.randomUUID() })).body.data.openingCount, 2);
});

test('malformed bodies, future dates, inactive or remapped categories cannot create receipts', async () => {
  const beforeCount = await receipts().countDocuments();
  for (const body of [{}, { openingId: crypto.randomUUID(), userId: String(reader) }, { openingId: 'invalid' }, { openingId: { $ne: null } }]) {
    assert.equal((await request(app).post(endpoint() + '/open').send(body)).status, 400);
  }
  assert.equal((await request(app).post(endpoint(free, '2026-10-26') + '/open').send({ openingId: crypto.randomUUID() })).status, 404);
  for (const change of [{ isActive: false }, { catalogueArchived: true }, { editorialSource: 'rdj_turf_quinte' }]) {
    await Category.collection.updateOne({ _id: free }, { $set: change });
    assert.equal((await request(app).post(endpoint() + '/open').send({ openingId: crypto.randomUUID() })).status, 404);
    await Category.collection.updateOne({ _id: free }, { $set: { isActive: true, catalogueArchived: false, editorialSource: 'rdj_petit_journal' } });
  }
  assert.equal(await receipts().countDocuments(), beforeCount);
});

test('missing explicit unique index rejects writes without inventing a count or creating indexes', async () => {
  const beforeCount = await receipts().countDocuments();
  await receipts().dropIndex(OPENING_IDENTITY_INDEX.name);
  assert.equal((await request(app).post(endpoint() + '/open').send({ openingId: crypto.randomUUID() })).status, 503);
  assert.equal(await receipts().countDocuments(), beforeCount);
  assert.equal((await receipts().listIndexes().toArray()).some(index => index.name === OPENING_IDENTITY_INDEX.name), false);
  await provision(mongoose.connection.db, { apply: true, intent: true });
});

test('opening totals persist across API database reconnection and receipts retain no reader identity', async () => {
  await mongoose.disconnect(); await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  assert.equal((await service.edition(String(free), date)).openingCount, 21);
  const docs = await receipts().find({}).toArray();
  for (const doc of docs) assert.deepEqual(Object.keys(doc).sort(), ['_id', 'categoryId', 'createdAt', 'editionDate', 'openingId']);
});
