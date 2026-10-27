// Explicit disposable replica set. No .env, application bootstrap or provider.
const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) throw new Error('Explicit disposable Mongo runtime/binary required');
process.env.NODE_ENV = 'test'; process.env.DISABLE_PUSH_NOTIFICATIONS = 'true';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const { provision } = require('../tools/editorial-indexes.cjs');
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
const EditorialItem = require('../src/api/models/common/EditorialItem');
const EditorialNotification = require('../src/api/models/common/EditorialNotification');
const { digest, fallback, factsFromBatch, boundCopy, notificationSnapshot, render, renderV2, validateCopy, V2_VERSION } = require('../src/api/services/common/editorialCopy');
const { copyId } = require('../src/api/services/common/editorialCopyStorage');
const crypto = require('node:crypto');
const source = 'rdj_petit_journal', editionDate = '2026-10-25', category = new mongoose.Types.ObjectId();
let mongo, repo, collection;
function payload(id = '101') { return { kind: 'match', sourceId: id, startsAtUtc: editionDate + 'T16:00:00.000Z',
  teams: { home: { name: 'Alpha' }, away: { name: 'Bravo' } }, sport: { key: 'football' }, competition: { name: 'League' },
  analysis: { fr: [{ paragraphs: ['Contexte exact.'] }] } }; }
function operation(item = payload(), cat = category) { return { updateOne: { filter: { categoryId: cat, source, editionDate, sourceId: item.sourceId },
  update: { $set: { kind: item.kind, payload: item, contentHash: crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex'), isPublished: true } }, upsert: true } }; }
function context(items = [payload()]) { return { source, editionDate, editorialCopy: fallback(factsFromBatch({ source, editionDate, items })) }; }
function alternativeContext() {
  const value = context(), facts = factsFromBatch({ source, editionDate, items: [payload()] });
  const choice = { angle: 'stakes', focusIds: ['101'] };
  value.editorialCopy = validateCopy(facts, { ...value.editorialCopy, method: 'gemini', model: 'gemini-3.5-flash-lite',
    cacheKey: '1'.repeat(64), nativeSha256: '2'.repeat(64), choice, body: render(facts, choice) });
  return value;
}
function v2Context() {
  const facts = factsFromBatch({ source, editionDate, items: [payload()] });
  const choice = { angle: 'context', focusIds: ['101'], entries: [{ id: '101',
    description: { fr: 'Alpha retrouve son public : quel elan pour ce rendez-vous ?', en: 'Alpha return home: what momentum do they bring?' },
    notification: { fr: 'Quel elan pour Alpha ?', en: 'What momentum for Alpha?' } }] };
  return { source, editionDate, editorialCopy: validateCopy(facts, { version: V2_VERSION, sourceHash: digest(facts), sourceIds: ['101'], choice,
    body: renderV2(facts, choice), notificationBody: renderV2(facts, choice, 'notification'), method: 'gemini',
    model: 'gemini-3.5-flash-lite', cacheKey: '1'.repeat(64), nativeSha256: '2'.repeat(64) }) };
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { systemBinary: process.env.WINTIPS_TEST_MONGO_BINARY },
    replSet: { count: 1, storageEngine: 'wiredTiger', spawn: { windowsHide: true } },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'] }] });
  const uri = mongo.getUri('wintips_copy_disposable'); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  await provision(mongoose.connection.db, { apply: true, intent: true });
  collection = mongoose.connection.db.collection('editorialcopies');
  repo = createEditorialRepository({ Category: {}, EditorialItem, subscriptionService: {}, accessGateService: {} });
}, { timeout: 180000 });
beforeEach(async () => { await EditorialItem.deleteMany({}); await EditorialNotification.deleteMany({}); await collection.deleteMany({}); });
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
test('new source/day copy and items commit together; exact retry preserves the immutable decision', async () => {
  const input = context(); await repo.upsertBatch([operation()], input);
  const initial = await collection.findOne({ _id: copyId(source, editionDate) });
  assert.equal(initial.appId, 'wintips'); assert.deepEqual(initial.copy, input.editorialCopy); assert.equal(initial.copySha256, digest(input.editorialCopy));
  assert.deepEqual(boundCopy(initial, await EditorialItem.find().lean()), input.editorialCopy);
  const replacement = alternativeContext();
  await repo.upsertBatch([operation()], replacement);
  const next = await collection.findOne({ _id: initial._id });
  for (const key of ['copy', 'copySha256', 'itemHashes', 'legacy', 'initialized']) assert.deepEqual(next[key], initial[key]);
  assert.equal(await EditorialItem.countDocuments(), 1);
});

test('new v2 description and short notification commit once with the exact item hashes and cannot be replaced on retry', async () => {
  const input = v2Context(); await repo.upsertBatch([operation()], input);
  const initial = await collection.findOne({ _id: copyId(source, editionDate) });
  assert.deepEqual(boundCopy(initial, await EditorialItem.find().lean()), input.editorialCopy);
  assert.notEqual(initial.copy.body.en, initial.copy.notificationBody.en);
  const before = await EditorialItem.findOne().lean();
  await repo.upsertBatch([operation()], alternativeContext());
  const after = await collection.findOne({ _id: initial._id });
  for (const key of ['copy', 'copySha256', 'itemHashes', 'legacy', 'initialized']) assert.deepEqual(after[key], initial[key]);
  const article = await EditorialItem.findOne().lean();
  assert.deepEqual(article.payload, before.payload); assert.equal(article.contentHash, before.contentHash);
});

test('a v2 retry preserves the exact stored v1 copy and completed notification snapshot without reclaiming delivery', async () => {
  const original = context(); await repo.upsertBatch([operation()], original);
  const before = await collection.findOne({ _id: copyId(source, editionDate) });
  const snapshot = notificationSnapshot({ items: await EditorialItem.find().lean(), editorialCopy: original.editorialCopy });
  const dal = createEditorialNotificationRepository({ EditorialNotification });
  const key = { appId: 'wintips', categoryId: category, source, editionDate }, now = new Date(editionDate + 'T08:00:00Z');
  const claimed = await dal.claim(key, 'stable', now, snapshot);
  await dal.finish(key, claimed.lockToken, { status: 'completed', stats: { accepted: 1 } }, now);
  const sent = await EditorialNotification.findOne().lean();
  await repo.upsertBatch([operation()], v2Context());
  const after = await collection.findOne({ _id: before._id });
  for (const field of ['copy', 'copySha256', 'itemHashes', 'legacy', 'initialized']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(await EditorialNotification.findOne().lean(), sent);
  const replacement = notificationSnapshot({ items: await EditorialItem.find().lean(), editorialCopy: v2Context().editorialCopy });
  assert.equal(await dal.claim(key, 'replacement', now, replacement), null);
  const terminal = await EditorialNotification.findOne().lean();
  for (const field of ['editorialCopy', 'editorialCopySha256', 'itemHash', 'notificationId', 'status', 'completedAt', 'stats', 'passes', 'lockToken']) {
    assert.deepEqual(terminal[field], sent[field]);
  }
  assert.equal(await EditorialNotification.countDocuments(), 1);
});
test('concurrent first imports select one copy and share one source/day registry across category mappings', async () => {
  const one = context(), two = alternativeContext();
  await Promise.all([repo.upsertBatch([operation()], one), repo.upsertBatch([operation(payload(), new mongoose.Types.ObjectId())], two)]);
  const records = await collection.find().toArray(); assert.equal(records.length, 1); assert.equal(records[0].initialized, true);
  assert.ok([one.editorialCopy.body.fr, two.editorialCopy.body.fr].includes(records[0].copy.body.fr));
  assert.equal(await EditorialItem.countDocuments(), 2);
});
test('all legacy source/day rows including unpublished/old category rows freeze a null copy with no retrofit', async () => {
  const old = operation(payload('old'), new mongoose.Types.ObjectId()); old.updateOne.update.$set.isPublished = false;
  await EditorialItem.bulkWrite([old]); const before = await EditorialItem.findOne().lean();
  await repo.upsertBatch([operation()], context());
  const record = await collection.findOne({ _id: copyId(source, editionDate) });
  assert.equal(record.legacy, true); assert.equal(record.copy, null); assert.equal(record.copySha256, null);
  assert.deepEqual(await EditorialItem.findById(before._id).lean(), before);
  await repo.upsertBatch([operation()], context()); assert.equal((await collection.findOne({ _id: record._id })).copy, null);
});
test('a historical notification without remaining items also prevents retrofitting a daily copy', async () => {
  await EditorialNotification.create({ appId: 'wintips', categoryId: category, source, editionDate, notificationId: 'old', status: 'completed' });
  const before = await EditorialNotification.findOne().lean();
  await repo.upsertBatch([operation()], context());
  assert.equal((await collection.findOne({ _id: copyId(source, editionDate) })).copy, null);
  assert.deepEqual(await EditorialNotification.findById(before._id).lean(), before);
});
test('publication without optional copy freezes null; a later copy cannot be added that day', async () => {
  await repo.upsertBatch([operation()], { source, editionDate, editorialCopy: null });
  await repo.upsertBatch([operation()], context());
  const record = await collection.findOne({ _id: copyId(source, editionDate) }); assert.equal(record.copy, null); assert.equal(record.initialized, true);
});
test('copy-state config distinguishes new/frozen/legacy with natural next-day reset and no read mutations', async () => {
  assert.deepEqual(await repo.copyStates([source], editionDate), [{ source, state: 'new', legacy: false }]);
  assert.equal(await collection.countDocuments(), 0);
  await repo.upsertBatch([operation()], context());
  const before = await collection.findOne({ _id: copyId(source, editionDate) });
  assert.deepEqual(await repo.copyStates([source], editionDate), [{ source, state: 'frozen', legacy: false }]);
  assert.deepEqual(await repo.copyStates([source], '2026-10-26'), [{ source, state: 'new', legacy: false }]);
  assert.deepEqual(await collection.findOne({ _id: before._id }), before);
  await collection.deleteMany({});
  assert.deepEqual(await repo.copyStates([source], editionDate), [{ source, state: 'frozen', legacy: true }]);
  assert.equal(await collection.countDocuments(), 0);
});
test('content failure rolls back initialized copy and all items; a safe retry can choose the first successful copy', async () => {
  const broken = createEditorialRepository({ Category: {}, EditorialItem: { db: EditorialItem.db, collection: EditorialItem.collection,
    bulkWrite: async () => { throw new Error('synthetic bulk failure'); } }, subscriptionService: {}, accessGateService: {} });
  await assert.rejects(broken.upsertBatch([operation()], context()), /synthetic bulk failure/);
  assert.equal(await EditorialItem.countDocuments(), 0); const record = await collection.findOne({ _id: copyId(source, editionDate) });
  assert.equal(record.initialized, false); assert.equal(record.copy, undefined);
  await repo.upsertBatch([operation()], context()); assert.equal((await collection.findOne({ _id: record._id })).initialized, true);
});
test('changed article hash invalidates display binding without overwriting the immutable copy', async () => {
  await repo.upsertBatch([operation()], context()); const before = await collection.findOne({ _id: copyId(source, editionDate) });
  const changed = payload(); changed.analysis.fr[0].paragraphs.push('Actualisation.');
  await repo.upsertBatch([operation(changed)], context([changed]));
  const next = await collection.findOne({ _id: before._id }); assert.deepEqual(next.copy, before.copy);
  assert.equal(boundCopy(next, await EditorialItem.find().lean()), null);
});
test('malformed duplicate identity or unprovisioned storage blocks before item writes and never creates a collection', async () => {
  await collection.insertOne({ _id: 'incorrect', appId: 'wintips', source, editionDate, initialized: false });
  await assert.rejects(repo.upsertBatch([operation()], context()), { statusCode: 409 }); assert.equal(await EditorialItem.countDocuments(), 0);
  await collection.drop(); await assert.rejects(repo.upsertBatch([operation()], context()), { statusCode: 503 });
  assert.equal((await mongoose.connection.db.listCollections({ name: 'editorialcopies' }).toArray()).length, 0);
  assert.deepEqual(await repo.copies([source], editionDate), []);
  await provision(mongoose.connection.db, { apply: true, intent: true, onlyCopies: true });
});
test('concurrent notification claims freeze one snapshot and resumed/terminal ledgers never accept a replacement', async () => {
  await repo.upsertBatch([operation()], context()); const row = await EditorialItem.findOne().lean(), value = context().editorialCopy;
  const snapshot = notificationSnapshot({ items: [row], editorialCopy: value });
  const dal = createEditorialNotificationRepository({ EditorialNotification });
  const key = { appId: 'wintips', categoryId: category, source, editionDate }, now = new Date('2026-10-25T08:00:00Z');
  const results = await Promise.all([dal.claim(key, 'stable', now, snapshot), dal.claim(key, 'stable', now, { ...snapshot, editorialCopy: null, editorialCopySha256: null })]);
  assert.equal(results.filter(Boolean).length, 1); let ledger = await EditorialNotification.findOne().lean();
  const frozen = { editorialCopy: ledger.editorialCopy, editorialCopySha256: ledger.editorialCopySha256, itemHash: ledger.itemHash };
  await dal.finish(key, ledger.lockToken, { status: 'pending' }, now);
  ledger = await dal.claim(key, 'stable', now, { ...snapshot, editorialCopy: { wrong: true }, itemHash: 'changed' });
  for (const name of Object.keys(frozen)) assert.deepEqual(ledger[name], frozen[name]);
  await dal.finish(key, ledger.lockToken, { status: 'completed' }, now);
  assert.equal(await dal.claim(key, 'other', now, snapshot), null);
  assert.equal(await EditorialNotification.countDocuments(), 1);
});
