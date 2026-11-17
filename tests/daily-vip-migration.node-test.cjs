const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, apply, PACKAGE_ID, CATEGORY_ID } = require('../src/api/migrations/dailyVipCategory.cjs');
const { DAILY_INDEX } = require('../src/api/services/common/dailyVipStorage');
const now = new Date('2026-11-17T11:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const str = value => String(value);
class ObjectId { constructor(value) { this.value = value; } toString() { return this.value; } toJSON() { return this.value; } }
function database() {
  const oldRights = ['111111111111111111111111', '222222222222222222222222'];
  const pkg = { _id: PACKAGE_ID, name: { fr: 'Black Friday', en: 'Black Friday' }, isActive: true, duration: 1, pricing: { XAF: 1000, USD: 10 }, categories: oldRights };
  const sub = (id, overrides = {}) => ({ _id: id, user: 'private-user', package: PACKAGE_ID, status: 'active', startDate: '2026-11-15T11:00:00.000Z',
    endDate: '2026-11-21T10:11:15.970Z', categorySnapshot: [...oldRights], ...overrides });
  const data = { packages: [pkg], categories: [], subscriptions: [sub('snapshot'), sub('legacy', { categorySnapshot: undefined }),
    sub('expired', { endDate: '2026-11-16T10:11:15.970Z' }), sub('cancelled', { status: 'cancelled' }), sub('other-package', { package: 'other' })] };
  const indexes = [DAILY_INDEX];
  let transaction = null, writes = 0;
  const equals = (a, b) => Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : str(a) === str(b);
  const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(query => matches(row, query));
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      if ('$gt' in expected) return new Date(row[key]) > new Date(expected.$gt);
      if ('$lte' in expected) return new Date(row[key]) <= new Date(expected.$lte);
      if ('$exists' in expected) return (row[key] !== undefined) === expected.$exists;
    }
    return equals(row[key], expected);
  });
  const db = { databaseName: 'wintips', collection(name) {
    const rows = () => (transaction || data)[name] || [];
    return {
      findOne: async filter => clone(rows().find(row => matches(row, filter)) || null),
      find: filter => ({ toArray: async () => clone(rows().filter(row => matches(row, filter))) }),
      listIndexes: () => ({ toArray: async () => indexes }), createIndex: async () => assert.fail('Index already provisioned'),
      insertOne: async row => { writes++; rows().push(clone(row)); },
      updateOne: async (filter, update) => {
        const row = rows().find(item => matches(item, filter)); if (!row) return { matchedCount: 0 };
        writes++;
        if (update.$set) Object.assign(row, clone(update.$set));
        if (update.$addToSet) for (const [key, value] of Object.entries(update.$addToSet)) if (!row[key].some(item => equals(item, value))) row[key].push(clone(value));
        return { matchedCount: 1 };
      },
    };
  } };
  const startSession = async () => ({ withTransaction: async callback => {
    transaction = clone(data);
    try { const result = await callback(); Object.assign(data, transaction); return result; } finally { transaction = null; }
  }, endSession: async () => {} });
  return { db, data, startSession, writes: () => writes };
}
test('explicit migration adds only the new category and preserves deadlines, prices, former rights and unrelated subscriptions', async () => {
  const { db, data, startSession, writes } = database(), before = clone(data);
  const prepared = await plan(db, ObjectId, { now });
  assert.equal(writes(), 0, 'planning is read-only');
  assert.equal(prepared.subscriptions.length, 2);
  await assert.rejects(apply(db, startSession, prepared, { now }), { code: 'DAILY_VIP_MIGRATION_CONFLICT' });
  assert.equal(writes(), 0);
  const result = await apply(db, startSession, prepared, { now, confirm: true });
  assert.equal(result.subscriptionsUpdated, 2); assert.equal(result.deadlinesChanged, false);
  assert.deepEqual(data.packages[0].pricing, before.packages[0].pricing);
  assert.deepEqual(data.packages[0].categories, [...before.packages[0].categories, CATEGORY_ID]);
  assert.equal(data.categories[0].editorialSource, 'wintips_daily_vip');
  assert.equal(data.categories[0].name.en, 'Daily Accumulator');
  assert.equal('successRate' in data.categories[0], false, 'no invented success statistics');
  for (const id of ['snapshot', 'legacy']) {
    const actual = data.subscriptions.find(sub => sub._id === id), old = before.subscriptions.find(sub => sub._id === id);
    assert.deepEqual(actual, { ...old, categorySnapshot: [...(old.categorySnapshot || before.packages[0].categories), CATEGORY_ID] });
  }
  for (const id of ['expired', 'cancelled', 'other-package']) assert.deepEqual(data.subscriptions.find(sub => sub._id === id), before.subscriptions.find(sub => sub._id === id));
  const again = await plan(db, ObjectId, { now });
  assert.equal(again.packageUpdate, false); assert.equal(again.subscriptions.length, 0);
  assert.equal((await apply(db, startSession, again, { now, confirm: true })).subscriptionsUpdated, 0);
});
test('a concurrent purchase or catalogue edit aborts rather than leaving an active pass without its new right', async () => {
  for (const change of [data => { data.packages[0].pricing.XAF = 2000; }, data => { data.subscriptions.push({ ...data.subscriptions[0], _id: 'new-purchase' }); },
    data => { data.subscriptions[0].endDate = '2026-11-21T11:00:00.000Z'; }]) {
    const { db, data, startSession } = database();
    const prepared = await plan(db, ObjectId, { now }); change(data);
    const beforeApply = clone(data);
    await assert.rejects(apply(db, startSession, prepared, { now, confirm: true }), { code: 'DAILY_VIP_MIGRATION_CONFLICT' });
    assert.deepEqual(clone(data), beforeApply, 'transaction rolls back all entitlement and catalogue changes');
  }
});
test('wrong database, package, or category mapping fails closed without granting another package', async () => {
  for (const mutate of [d => { d.db.databaseName = 'bigwin-api-v2'; }, d => { d.data.packages[0].isActive = false; },
    d => { d.data.categories.push({ _id: 'different-category', editorialSource: 'wintips_daily_vip', isVip: true, isActive: true }); }]) {
    const state = database(); mutate(state);
    await assert.rejects(plan(state.db, ObjectId, { now }), { code: 'DAILY_VIP_MIGRATION_CONFLICT' });
    assert.equal(state.writes(), 0);
  }
});
