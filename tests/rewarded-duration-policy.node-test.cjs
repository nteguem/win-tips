'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../src/api/services/common/rewardedDurationPolicy');
const { parseArgs } = require('../tools/rewarded-duration-policy.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const full = [60, 1440, 10080, 43200].map((durationMinutes, index) => ({ durationMinutes, adsRequired: [4, 12, 20, 50][index] }));
const small = [{ durationMinutes: 1440, adsRequired: 3 }, { durationMinutes: 10080, adsRequired: 12 }, { durationMinutes: null, adsRequired: 20 }];
const category = (digit, options = full, patch = {}) => ({ _id: digit.repeat(24), appId: 'bigwin', appIds: policy.APPS,
  isActive: true, isVip: false, name: { fr: 'Conservé', en: 'Preserved' }, accessGate: { type: 'ad_reward', options }, ...patch });
const planFor = rows => policy.createPlan({ scope: 'bigwin-five', databaseName: 'bigwin-api-v2', categories: rows });

test('the actual six-category catalogue receives the same rational durations in every BigWin app', () => {
  const rows = [category('a'), category('b'), ...['goatips', 'wisetips', 'strategytips', 'goodtips'].map((appId, index) =>
    category(String(index + 1), small, { appId, appIds: [appId] }))], before = copy(rows), plan = planFor(rows);
  assert.deepEqual(rows, before);
  assert.equal(plan.operations.length, 6); assert.equal(plan.categoriesExamined, 6);
  assert.deepEqual(plan.operations.find(op => op.id === 'a'.repeat(24)).nextOptions,
    [60, 1440, 10080, 43200].map((durationMinutes, index) => ({ durationMinutes, adsRequired: [2, 3, 8, 15][index] })));
  assert.deepEqual(plan.operations.find(op => op.id === '1'.repeat(24)).nextOptions,
    [{ durationMinutes: 1440, adsRequired: 3 }, { durationMinutes: 10080, adsRequired: 8 }, { durationMinutes: null, adsRequired: 20 }]);
  assert.equal(plan.userProgressModified, false); assert.equal(plan.paidEntitlementsModified, false);
  policy.verifyPlan(plan, plan.planHash);
});
test('WinTips remains ungated and no absent category or duration is invented', () => {
  const plan = policy.createPlan({ scope: 'wintips', databaseName: 'wintips', categories: [category('a', full, { appId: undefined, accessGate: null })] });
  assert.equal(plan.operations.length, 0); policy.verifyPlan(plan, plan.planHash);
  const future = policy.createPlan({ scope: 'wintips', databaseName: 'wintips', categories: [category('a', [{ durationMinutes: 60, adsRequired: 4 }], { appId: undefined, appIds: undefined })] });
  assert.deepEqual(future.operations[0].nextOptions, [{ durationMinutes: 60, adsRequired: 2 }]);
});
test('cheaper offers, disabled or VIP categories and other apps remain intact', () => {
  const cheap = category('a', [{ durationMinutes: 60, adsRequired: 1 }]);
  assert.equal(planFor([cheap, category('b', full, { isActive: false }), category('c', full, { isVip: true }),
    category('d', full, { appId: 'other', appIds: ['other'] })]).operations.length, 0);
});
test('unknown, duplicate and noninteger thresholds fail before producing a migration', () => {
  for (const options of [[{ durationMinutes: 120, adsRequired: 4 }], [{ durationMinutes: 60, adsRequired: 1.1 }],
    [{ durationMinutes: 60, adsRequired: 2 }, { durationMinutes: 60, adsRequired: 4 }]]) {
    assert.throws(() => planFor([category('a', options)]), { code: 'DURATION_OPTION_REQUIRES_REVIEW' });
  }
});
test('a modified plan fails its hash, and even a rehashed broader plan is rejected', () => {
  const plan = planFor([category('a')]), changed = copy(plan);
  changed.operations[0].nextOptions[0].adsRequired = 50;
  assert.throws(() => policy.verifyPlan(changed, plan.planHash), { code: 'DURATION_PLAN_HASH_MISMATCH' });
  for (const mutate of [p => p.operations[0].nextOptions[0].adsRequired = 50,
    p => p.operations[0].nextOptions[0].durationMinutes = 61, p => p.userProgressModified = true,
    p => p.operations[0].collection = 'users', p => p.operations[0].before.isVip = true]) {
    const value = copy(plan); mutate(value); delete value.planHash; value.planHash = policy.hash(value);
    assert.throws(() => policy.verifyPlan(value, value.planHash));
  }
});
test('plan/apply requires an exact scope, output and mutation intent', () => {
  assert.equal(parseArgs(['--scope', 'wintips', '--out', 'plan.json']).mode, 'plan');
  for (const args of [[], ['--scope', 'other', '--out', 'x'], ['--scope', 'wintips', '--out', 'x', '--apply'],
    ['--scope', 'wintips', '--out', 'x', '--plan', '--rollback']]) assert.throws(() => parseArgs(args));
});
function database(rows) {
  const state = { rows: copy(rows), writes: [], sessions: 0, ended: 0, replica: true, refuse: false };
  const collection = { async findOne(query) { return state.rows.find(row => row._id === query._id); },
    async updateOne(filter, update) {
      state.writes.push({ filter: copy(filter), update: copy(update) });
      assert.deepEqual(Object.keys(update), ['$set']); assert.deepEqual(Object.keys(update.$set), ['accessGate.options']);
      if (state.refuse) return { matchedCount: 0, modifiedCount: 0 };
      const row = state.rows.find(value => value._id === filter.$and[0]._id);
      row.accessGate.options = copy(update.$set['accessGate.options']); return { matchedCount: 1, modifiedCount: 1 };
    } };
  const db = { databaseName: 'bigwin-api-v2', admin() { return { async command() { return state.replica ? { setName: 'rs0' } : {}; } }; },
    collection(name) { assert.equal(name, 'categories'); return collection; } };
  const client = { startSession() { state.sessions++; return { async withTransaction(fn) {
    const saved = copy(state.rows); try { await fn(); } catch (e) { state.rows = saved; throw e; }
  }, async endSession() { state.ended++; } }; } };
  return { state, db, client };
}
test('transaction updates only category options, keeps unrelated fields and applies idempotently', async () => {
  const rows = [category('a'), category('b', small)], plan = planFor(rows), f = database(rows);
  f.state.rows[0].name.fr = 'Concurrent name edit';
  const settings = { confirmHash: plan.planHash, objectId: value => value };
  const first = await policy.applyPlan(f.db, f.client, plan, settings);
  assert.equal(first.changed, 2); assert.equal(f.state.rows[0].name.fr, 'Concurrent name edit');
  assert.equal((await policy.applyPlan(f.db, f.client, plan, settings)).skipped, 2);
  assert.equal(f.state.writes.length, 2); assert.equal(f.state.ended, 2);
  await policy.applyPlan(f.db, f.client, plan, { ...settings, mode: 'rollback' });
  assert.deepEqual(f.state.rows[0].accessGate.options, rows[0].accessGate.options);
  assert.equal(f.state.rows[0].name.fr, 'Concurrent name edit');
});
test('a stale second category aborts the whole transaction and preserves BO changes', async () => {
  const rows = [category('a'), category('b')], plan = planFor(rows), f = database(rows);
  f.state.rows[1].accessGate.options[0].adsRequired = 3;
  await assert.rejects(policy.applyPlan(f.db, f.client, plan, { confirmHash: plan.planHash, objectId: value => value }), { code: 'DURATION_STALE_PLAN' });
  assert.deepEqual(f.state.rows[0].accessGate.options, rows[0].accessGate.options);
  assert.equal(f.state.rows[1].accessGate.options[0].adsRequired, 3); assert.equal(f.state.ended, 1);
});
test('rollback never overwrites a later independent BO edit', async () => {
  const rows = [category('a')], plan = planFor(rows), f = database(rows), settings = { confirmHash: plan.planHash, objectId: value => value };
  await policy.applyPlan(f.db, f.client, plan, settings); f.state.rows[0].accessGate.options[0].adsRequired = 1;
  await assert.rejects(policy.applyPlan(f.db, f.client, plan, { ...settings, mode: 'rollback' }), { code: 'DURATION_STALE_PLAN' });
  assert.equal(f.state.rows[0].accessGate.options[0].adsRequired, 1);
});
test('no nontransactional fallback, wrong database or failed CAS can apply', async () => {
  const rows = [category('a')], plan = planFor(rows), settings = { confirmHash: plan.planHash, objectId: value => value };
  const noReplica = database(rows); noReplica.state.replica = false;
  await assert.rejects(policy.applyPlan(noReplica.db, noReplica.client, plan, settings), { code: 'DURATION_TRANSACTION_REQUIRED' });
  assert.equal(noReplica.state.sessions, 0);
  const wrong = database(rows); wrong.db.databaseName = 'other';
  await assert.rejects(policy.applyPlan(wrong.db, wrong.client, plan, settings), { code: 'DURATION_APPLY_SCOPE_INVALID' });
  const cas = database(rows); cas.state.refuse = true;
  await assert.rejects(policy.applyPlan(cas.db, cas.client, plan, settings), { code: 'DURATION_CAS_REFUSED' });
  assert.deepEqual(cas.state.rows, rows);
});

// Evaluate the actual Mongo update expression against a simulated concurrent
// SSV write, rather than mocking the result of startOrSwitchUnlock itself.
function evaluate(value, doc, now) {
  if (typeof value === 'string' && value === '$$NOW') return now;
  if (typeof value === 'string' && value.startsWith('$')) return value.slice(1).split('.').reduce((row, key) => row?.[key], doc);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => evaluate(item, doc, now));
  if ('$literal' in value) return copy(value.$literal);
  if ('$ifNull' in value) { const [a, b] = evaluate(value.$ifNull, doc, now); return a ?? b; }
  if ('$gte' in value) { const [a, b] = evaluate(value.$gte, doc, now); return a >= b; }
  if ('$eq' in value) { const [a, b] = evaluate(value.$eq, doc, now); return a === b; }
  if ('$cond' in value) return evaluate(value.$cond[0], doc, now) ? evaluate(value.$cond[1], doc, now) : evaluate(value.$cond[2], doc, now);
  if ('$add' in value) { const [a, b] = evaluate(value.$add, doc, now); return a instanceof Date ? new Date(a.getTime() + b) : a + b; }
  throw Error('Unexpected expression');
}
function unlockFixture({ verifiedCount = 1, concurrentRewards = 0, active = false, finalCallbackWins = false } = {}) {
  const now = new Date(), doc = { _id: 'unlock', nonce: 'unchanged-signed-nonce', status: active ? 'unlocked' : 'in_progress',
    verifiedCount, selectedOption: { durationMinutes: 60, adsRequired: 4 }, rewards: [{ transactionId: 'verified-1' }],
    unlockedAt: active ? now : null, expiresAt: active ? new Date(now.getTime() + 3600000) : null,
    isAccessActive() { return this.status === 'unlocked' && this.expiresAt > new Date(); },
    async save() { throw Error('a pending attempt must never save a stale counter'); } };
  let updates = 0;
  const unlock = { async findOne() { return doc; }, async findOneAndUpdate(filter, pipeline) {
    updates++; assert.equal(filter.nonce, doc.nonce); assert.equal(filter.status, 'in_progress'); assert.equal(filter._id, doc._id);
    doc.verifiedCount += concurrentRewards;
    if (finalCallbackWins) { doc.status = 'unlocked'; doc.unlockedAt = now; doc.expiresAt = new Date(now.getTime() + 3600000); return null; }
    for (const stage of pipeline) {
      assert.ok(!Object.hasOwn(stage.$set, 'verifiedCount')); assert.ok(!Object.hasOwn(stage.$set, 'nonce')); assert.ok(!Object.hasOwn(stage.$set, 'rewards'));
      const next = Object.fromEntries(Object.entries(stage.$set).map(([key, value]) => [key, evaluate(value, doc, now)])); Object.assign(doc, next);
    }
    return doc;
  } };
  class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
  const file = path.join(__dirname, '../src/api/services/common/accessGateService.js'), module = { exports: {} };
  const mocks = { mongoose: {}, '../../models/common/UserAccessUnlock': unlock, '../../../utils/AppError': { AppError, ErrorCodes: {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Date,
    require(name) { if (name === 'crypto') return require(name); if (Object.hasOwn(mocks, name)) return mocks[name]; throw Error('Unmocked ' + name); } }, { filename: file });
  const service = module.exports, multi = fs.readFileSync(file, 'utf8').includes('startOrSwitchUnlock(appId,');
  const cat = { _id: 'category', accessGate: { type: 'ad_reward', options: [{ durationMinutes: 60, adsRequired: 2 }] } };
  return { doc, get updates() { return updates; }, start: () => service.startOrSwitchUnlock(...(multi ? ['bigwin', 'user', cat, 60] : ['user', cat, 60])) };
}
test('repricing a pending attempt keeps all verified progress, SSV receipts and the exact nonce', async () => {
  const f = unlockFixture(), result = await f.start();
  assert.equal(result.adsRequired, 2); assert.equal(result.verifiedCount, 1); assert.equal(result.isAccessActive, false);
  assert.equal(result.nonce, 'unchanged-signed-nonce'); assert.equal(f.doc.rewards[0].transactionId, 'verified-1'); assert.equal(f.updates, 1);
});
test('a simultaneous SSV is counted atomically and grants the cheaper offer immediately', async () => {
  const f = unlockFixture({ verifiedCount: 1, concurrentRewards: 1 }), result = await f.start();
  assert.equal(result.verifiedCount, 2); assert.equal(result.adsRequired, 2); assert.equal(result.isAccessActive, true);
  assert.equal(result.expiresAt.getTime() - result.unlockedAt.getTime(), 3600000);
});
test('already verified progress above the new threshold is never discarded', async () => {
  const f = unlockFixture({ verifiedCount: 3 }), result = await f.start();
  assert.equal(result.verifiedCount, 3); assert.equal(result.isAccessActive, true); assert.equal(result.adsRequired, 2);
});
test('a final callback racing ahead of repricing retains its already granted duration', async () => {
  const f = unlockFixture({ verifiedCount: 3, concurrentRewards: 1, finalCallbackWins: true }), result = await f.start();
  assert.equal(result.verifiedCount, 4); assert.equal(result.adsRequired, 4); assert.equal(result.isAccessActive, true);
  assert.equal(result.nonce, 'unchanged-signed-nonce');
});
test('already active access cannot be repriced or have its expiry reset', async () => {
  const f = unlockFixture({ verifiedCount: 4, active: true }), expiry = f.doc.expiresAt.getTime();
  await assert.rejects(f.start(), error => error.statusCode === 409); assert.equal(f.updates, 0); assert.equal(f.doc.expiresAt.getTime(), expiry);
});
