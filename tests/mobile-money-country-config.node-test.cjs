'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// A VM import proves that planning/tests do not load MongoDB, provider SDKs,
// dotenv, bootstrap the application, or contact an external service.
const moduleMock = { exports: {} };
const allowedRequires = [];
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tools/mobile-money-country-config.cjs'), 'utf8'), {
  module: moduleMock, exports: moduleMock.exports,
  require: name => {
    allowedRequires.push(name);
    if (name === 'node:crypto') return crypto;
    throw new Error('Unexpected test dependency: ' + name);
  },
});
const tool = moduleMock.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected) => assert.deepEqual(clone(actual), clone(expected));
const active = ['CD', 'CG', 'CI', 'GA', 'RW', 'SL', 'SN', 'UG', 'ZM', 'CM', 'TZ'];

function rows() {
  return tool.TARGETS.map((target, index) => ({
    _id: (index + 1).toString(16).padStart(24, '0'),
    countryCode: target.countryCode, countryName: 'Synthetic ' + target.countryCode,
    paymentProvider: 'googlepay', currency: 'USD', phonePrefix: '+1',
    language: index % 2 ? 'en' : 'fr', isActive: true,
    metadata: { timezone: 'Synthetic/Zone', callingCode: 'preserved' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z',
  })).concat([
    { _id: 'a'.repeat(24), countryCode: 'CM', countryName: 'Synthetic CM', currency: 'XAF',
      paymentProvider: 'smobilpay', phonePrefix: '+237', language: 'fr', isActive: true },
    { _id: 'b'.repeat(24), countryCode: 'DEFAULT', countryName: 'International', currency: 'USD',
      paymentProvider: 'googlepay', phonePrefix: '+1', language: 'en', isActive: true },
  ]);
}

function database(seed = rows(), mutateWrite) {
  let stored = clone(seed);
  const writes = [];
  const findSnapshots = [];
  let transactions = 0;
  const collection = {
    find(filter, options) {
      same(JSON.parse(JSON.stringify(filter)), {});
      findSnapshots.push(options.session);
      return { limit: () => ({ toArray: async () => clone(stored) }) };
    },
    async updateOne(filter, update, options) {
      assert.equal(options.upsert, false);
      assert.ok(options.session);
      same(Object.keys(update), ['$set']);
      assert.ok(Object.keys(update.$set).every(field => tool.FIELDS.includes(field)));
      same(Object.keys(filter).sort(), ['_id', 'countryCode', ...tool.FIELDS].sort());
      writes.push(clone({ filter, update }));
      if (mutateWrite) mutateWrite(writes.length, stored, filter, update);
      const row = stored.find(candidate => Object.entries(filter).every(([key, value]) => candidate[key] === value));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, clone(update.$set));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const db = {
    databaseName: 'wintips',
    collection(name) { assert.equal(name, 'appconfigs'); return collection; },
    admin: () => ({ command: async () => ({ setName: 'synthetic-replica' }) }),
  };
  const client = { startSession() {
    return { async withTransaction(callback, options) {
      assert.equal(options.writeConcern.w, 'majority');
      assert.equal(options.readConcern.level, 'snapshot');
      const before = clone(stored);
      transactions++;
      try { return await callback(); } catch (error) { stored = before; throw error; }
    }, async endSession() {} };
  } };
  return { db, client, writes, findSnapshots,
    rows: () => clone(stored), setRows: value => { stored = clone(value); }, transactions: () => transactions };
}
const identity = id => id;
const apply = (memory, plan, extras = {}) => tool.applyPlan({ ...memory, plan,
  confirmedHash: plan.planHash, intent: true, activePawaCountries: active, idFactory: identity, ...extras });

test('VM import and pure planning use only node crypto and never mutate input rows', () => {
  const source = rows(); const before = clone(source);
  const plan = tool.planCountryConfig(source, active);
  same(allowedRequires, ['node:crypto']);
  same(source, before);
  assert.equal(plan.operations.length, 13);
  assert.equal(plan.changedCount, 13);
  assert.match(plan.idSha256, /^[a-f\d]{64}$/);
  assert.match(plan.planHash, /^[a-f\d]{64}$/);
  assert.equal(plan.priceWrites, 0);
  assert.equal(plan.requiresAppConfigRefresh, true);
});

test('exact confirmed country mapping includes Kora four and Pawa nine only', () => {
  const expected = {
    GH: ['korapay', 'GHS', '+233'], KE: ['korapay', 'KES', '+254'],
    NG: ['korapay', 'NGN', '+234'], ZA: ['korapay', 'ZAR', '+27'],
    CD: ['pawapay', 'CDF', '+243'], CG: ['pawapay', 'XAF', '+242'],
    CI: ['pawapay', 'XOF', '+225'], GA: ['pawapay', 'XAF', '+241'],
    RW: ['pawapay', 'RWF', '+250'], SL: ['pawapay', 'SLE', '+232'],
    SN: ['pawapay', 'XOF', '+221'], UG: ['pawapay', 'UGX', '+256'], ZM: ['pawapay', 'ZMW', '+260'],
  };
  const plan = tool.planCountryConfig(rows(), active);
  same(plan.operations.map(op => op.countryCode).sort(), Object.keys(expected).sort());
  for (const op of plan.operations) {
    same([op.after.paymentProvider, op.after.currency, op.after.phonePrefix], expected[op.countryCode]);
    const before = clone(op.before), after = clone(op.after);
    for (const field of tool.FIELDS) { delete before[field]; delete after[field]; }
    same(before, after);
  }
  same(plan.protectedOtherCountries.map(row => row.countryCode).sort(), ['CM', 'DEFAULT']);
});

test('planning hashes are stable across database and provider catalogue ordering', () => {
  const one = tool.planCountryConfig(rows(), active);
  const two = tool.planCountryConfig(rows().reverse(), [...active].reverse());
  assert.equal(one.planHash, two.planHash);
  assert.equal(one.idSha256, two.idSha256);
  const changed = rows(); changed[0]._id = 'c'.repeat(24);
  assert.notEqual(tool.planCountryConfig(changed, active).idSha256, one.idSha256);
});

test('every missing target or unavailable Pawa country prevents a plan', () => {
  for (const target of tool.TARGETS) {
    assert.throws(() => tool.planCountryConfig(rows().filter(row => row.countryCode !== target.countryCode), active),
      /TARGET_COUNTRY_CONFIG_MISSING/);
    if (target.paymentProvider === 'pawapay') {
      assert.throws(() => tool.planCountryConfig(rows(), active.filter(code => code !== target.countryCode)),
        /TARGET_PAWAPAY_COUNTRY_NOT_ACTIVE/);
    }
  }
  assert.throws(() => tool.planCountryConfig(rows(), undefined), /EXPLICIT_ACTIVE/);
  const duplicate = rows(); duplicate.push(clone(duplicate[0]));
  assert.throws(() => tool.planCountryConfig(duplicate, active), /DUPLICATE_COUNTRY_CONFIG/);
});

test('a rehashed plan cannot alter language, metadata, prices, mappings, identifiers, or scope', () => {
  const original = tool.planCountryConfig(rows(), active);
  for (const mutate of [
    plan => { plan.operations[0].after.language = 'en'; },
    plan => { plan.operations[0].after.pricing = { XAF: 100 }; },
    plan => { plan.operations[0].after.metadata.timezone = 'Changed/Zone'; },
    plan => { plan.operations[0].after.paymentProvider = 'korapay'; },
    plan => { plan.operations[0].id = 'c'.repeat(24); },
    plan => { plan.allowedFields.push('language'); },
    plan => { plan.priceWrites = 1; },
  ]) {
    const plan = clone(original); mutate(plan);
    delete plan.planHash; plan.planHash = tool.hash(plan);
    assert.throws(() => tool.verifyPlan(plan, plan.planHash), /COUNTRY_CONFIG_PLAN_SCOPE_INVALID/);
  }
});

test('apply writes only the three diff fields with original-value optimistic filters', async () => {
  const seed = rows(), plan = tool.planCountryConfig(seed, active), memory = database(seed);
  const receipt = await apply(memory, plan);
  assert.equal(receipt.applied, 13); assert.equal(receipt.skipped, 0);
  assert.equal(memory.transactions(), 1); assert.equal(memory.writes.length, 13);
  assert.ok(memory.findSnapshots.every(Boolean));
  for (const write of memory.writes) {
    assert.equal(write.filter.paymentProvider, 'googlepay');
    assert.equal(write.filter.currency, 'USD');
    assert.equal(write.filter.phonePrefix, '+1');
    assert.ok(Object.keys(write.update.$set).every(field => tool.FIELDS.includes(field)));
  }
  for (const op of plan.operations) {
    same(memory.rows().find(row => row._id === op.id), clone(op.after));
  }
  same(memory.rows().filter(row => ['CM', 'DEFAULT'].includes(row.countryCode)), seed.slice(-2));
  assert.match(receipt.receiptHash, /^[a-f\d]{64}$/);
});

test('repeat apply is idempotent and performs zero additional writes', async () => {
  const memory = database(), plan = tool.planCountryConfig(memory.rows(), active);
  await apply(memory, plan);
  const receipt = await apply(memory, plan);
  assert.equal(receipt.applied, 0); assert.equal(receipt.skipped, 13);
  assert.equal(memory.writes.length, 13);
});

test('absent intent, hash, current provider coverage or wrong database blocks writes', async () => {
  const memory = database(), plan = tool.planCountryConfig(memory.rows(), active);
  await assert.rejects(apply(memory, plan, { intent: false }), /MUTATION_NOT_CONFIRMED/);
  await assert.rejects(apply(memory, plan, { confirmedHash: '' }), /EXACT_COUNTRY_CONFIG_PLAN/);
  await assert.rejects(apply(memory, plan, { activePawaCountries: active.filter(code => code !== 'SN') }), /NOT_ACTIVE/);
  await assert.rejects(apply({ ...memory, db: { ...memory.db, databaseName: 'bigwin' } }, plan), /WRONG_COUNTRY_CONFIG_DATABASE/);
  assert.equal(memory.writes.length, 0);
});

test('unrelated config edits, target edits or missing IDs invalidate a stale plan', async () => {
  for (const mutate of [
    seed => { seed[0].language = seed[0].language === 'en' ? 'fr' : 'en'; },
    seed => { seed.at(-1).phonePrefix = '+999'; },
    seed => { seed.pop(); },
  ]) {
    const memory = database(), plan = tool.planCountryConfig(memory.rows(), active);
    const changed = memory.rows(); mutate(changed); memory.setRows(changed);
    await assert.rejects(apply(memory, plan), /DRIFT|STALE/);
    assert.equal(memory.writes.length, 0);
  }
});

test('optimistic mismatch aborts every earlier write within the transaction', async () => {
  const seed = rows();
  const memory = database(seed, (number, stored) => { if (number === 3) stored[2].currency = 'EUR'; });
  const plan = tool.planCountryConfig(seed, active);
  await assert.rejects(apply(memory, plan), /WRITE_NOT_MATCHED/);
  same(memory.rows(), seed);
});

test('standalone MongoDB is refused before any config writes', async () => {
  const memory = database(), plan = tool.planCountryConfig(memory.rows(), active);
  memory.db.admin = () => ({ command: async () => ({ ok: 1 }) });
  await assert.rejects(apply(memory, plan), /TRANSACTIONS_REQUIRED/);
  assert.equal(memory.writes.length, 0);
});

test('rollback exports restore only mapped values using expected-after optimistic filters', async () => {
  const seed = rows(), memory = database(seed), plan = tool.planCountryConfig(seed, active);
  const receipt = await apply(memory, plan);
  const exported = tool.rollbackOperations(receipt, receipt.receiptHash);
  assert.equal(exported.length, 13);
  assert.equal(exported[0].filter.countryCode, 'ZM');
  assert.equal(exported[0].filter.paymentProvider, 'pawapay');
  assert.equal(exported[0].update.$set.paymentProvider, 'googlepay');
  const result = await tool.rollback({ ...memory, receipt, confirmedHash: receipt.receiptHash,
    intent: true, idFactory: identity });
  assert.equal(result.restored, 13); assert.equal(result.skipped, 0);
  same(memory.rows(), seed);
  const repeated = await tool.rollback({ ...memory, receipt, confirmedHash: receipt.receiptHash,
    intent: true, idFactory: identity });
  assert.equal(repeated.restored, 0); assert.equal(repeated.skipped, 13);
});

test('rollback cannot clobber subsequent edits and requires an exact receipt hash', async () => {
  const memory = database(), plan = tool.planCountryConfig(memory.rows(), active);
  const receipt = await apply(memory, plan);
  assert.throws(() => tool.rollbackOperations(receipt, '0'.repeat(64)), /EXACT_COUNTRY_CONFIG_ROLLBACK/);
  const changed = memory.rows(); changed[0].metadata.owner = 'subsequent edit'; memory.setRows(changed);
  await assert.rejects(tool.rollback({ ...memory, receipt, confirmedHash: receipt.receiptHash,
    intent: true, idFactory: identity }), /STALE_COUNTRY_CONFIG_ROLLBACK/);
  same(memory.rows(), changed);
});
