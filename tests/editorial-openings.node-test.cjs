const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpeningStorage, COLLECTION } = require('../src/api/services/common/editorialOpeningStorage');
const { OPENING_IDENTITY_INDEX } = require('../src/api/services/common/editorialIndexIdentity');
const { inspect, COLLECTIONS } = require('../tools/editorial-indexes.cjs');
const a = 'a'.repeat(24), date = '2026-10-25', uuid = '4f5ca989-95f4-4e8e-a335-73de107ebc67';
const storage = collection => createOpeningStorage({ db: { db: { collection: name => { assert.equal(name, COLLECTION); return collection; } } } });

test('opening writes require an explicitly provisioned exact unique non-expiring receipt index', async () => {
  for (const index of [null, { ...OPENING_IDENTITY_INDEX, unique: false }, { ...OPENING_IDENTITY_INDEX, sparse: true },
    { ...OPENING_IDENTITY_INDEX, hidden: true }, { ...OPENING_IDENTITY_INDEX, partialFilterExpression: { openingId: { $exists: true } } },
    { ...OPENING_IDENTITY_INDEX, collation: { locale: 'en', strength: 2 } }, { ...OPENING_IDENTITY_INDEX, expireAfterSeconds: 0 },
    { ...OPENING_IDENTITY_INDEX, key: { openingId: 1, categoryId: 1, editionDate: 1 } }]) {
    let writes = 0;
    const repo = storage({ listIndexes: () => ({ toArray: async () => index ? [index] : [] }), insertOne() { writes++; } });
    await assert.rejects(repo.record(a, date, uuid, new Date()), { statusCode: 503 });
    assert.equal(writes, 0);
  }
});

test('opening provisioning and runtime share the index definition and fail on conflicting options', async () => {
  assert.deepEqual(COLLECTIONS[COLLECTION], [OPENING_IDENTITY_INDEX]);
  const collections = Object.fromEntries(Object.entries(COLLECTIONS).map(([name, specs]) => [name, specs.map(spec => ({ ...spec }))]));
  collections[COLLECTION][0] = { ...OPENING_IDENTITY_INDEX, expireAfterSeconds: 0 };
  const result = await inspect({ collection: name => ({ listIndexes: () => ({ toArray: async () => collections[name] }) }) });
  assert.deepEqual(result.conflicts, [OPENING_IDENTITY_INDEX.name]);
});

test('an inserted receipt survives a response/count failure and the same action retry does not increment again', async () => {
  const receipts = new Map(); let failCountOnce = true;
  const scopeMatches = (receipt, query) => Object.entries(query).every(([key, value]) => receipt[key] === value);
  const repo = storage({
    listIndexes: () => ({ toArray: async () => [OPENING_IDENTITY_INDEX] }),
    async insertOne(receipt) {
      if (receipts.has(receipt._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      receipts.set(receipt._id, receipt);
    },
    async findOne(query) { return [...receipts.values()].find(receipt => scopeMatches(receipt, query)); },
    async countDocuments(query) {
      if (failCountOnce) { failCountOnce = false; throw Object.assign(new Error('temporary read failure'), { code: 'TEST_READ_FAILURE' }); }
      return [...receipts.values()].filter(receipt => scopeMatches(receipt, query)).length;
    },
  });
  await assert.rejects(repo.record(a, date, uuid, new Date()), { code: 'TEST_READ_FAILURE' });
  assert.equal(receipts.size, 1);
  assert.deepEqual(await repo.record(a, date, uuid, new Date()), { counted: false, openingCount: 1 });
  assert.equal(receipts.size, 1);
  assert.deepEqual(Object.keys([...receipts.values()][0]).sort(), ['_id', 'categoryId', 'createdAt', 'editionDate', 'openingId']);
});

test('a duplicate-key error without the exact scoped action is never silently accepted as a retry', async () => {
  const repo = storage({
    listIndexes: () => ({ toArray: async () => [OPENING_IDENTITY_INDEX] }),
    async insertOne() { throw Object.assign(new Error('unrelated index conflict'), { code: 11000 }); },
    async findOne() { return null; },
    countDocuments() { throw new Error('Unexpected count after a conflicting insert'); },
  });
  await assert.rejects(repo.record(a, date, uuid, new Date()), { code: 11000 });
});

test('opening list counts use one bounded category/date aggregation and perform no writes', async () => {
  let pipeline;
  const repo = storage({ aggregate(value) { pipeline = value; return { toArray: async () => [{ _id: a, openingCount: 7 }] }; } });
  assert.deepEqual(await repo.counts([a], date), [{ categoryId: a, openingCount: 7 }]);
  assert.deepEqual(pipeline, [{ $match: { categoryId: { $in: [a] }, editionDate: date } }, { $group: { _id: '$categoryId', openingCount: { $sum: 1 } } }]);
  pipeline = undefined; assert.deepEqual(await repo.counts([], date), []); assert.equal(pipeline, undefined);
});
