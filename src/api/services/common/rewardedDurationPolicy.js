'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const VERSION = 'rewarded-duration-limits-v1';
const APPS = Object.freeze(['bigwin', 'goatips', 'goodtips', 'wisetips', 'strategytips']);
const LIMITS = Object.freeze({ 60: 2, 1440: 3, 10080: 8, 43200: 15, lifetime: 20 });
const DATABASES = Object.freeze({ 'bigwin-five': 'bigwin-api-v2', wintips: 'wintips' });
const GUARDS = Object.freeze(['appId', 'appIds', 'isActive', 'isVip', 'editorialSource', 'accessGate']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const critical = row => Object.fromEntries(GUARDS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
function inScope(row, scope) {
  if (scope === 'wintips') return !row.appId || row.appId === 'wintips';
  if (scope !== 'bigwin-five') return false;
  return (APPS.includes(row.appId) || row.appId === 'shared') &&
    (!Array.isArray(row.appIds) || row.appIds.every(id => APPS.includes(id)));
}
function optionsFor(row) {
  const options = row.accessGate?.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > 10) fail('DURATION_OPTIONS_INVALID');
  const seen = new Set();
  return options.map(option => {
    const key = option.durationMinutes == null ? 'lifetime' : String(option.durationMinutes);
    if (!Object.hasOwn(LIMITS, key) || seen.has(key) || !Number.isSafeInteger(option.adsRequired) || option.adsRequired < 1)
      fail('DURATION_OPTION_REQUIRES_REVIEW');
    seen.add(key);
    // Never make an existing offer more expensive. Durations and other fields
    // remain identical; the back office remains the source of truth afterwards.
    return { ...option, adsRequired: Math.min(option.adsRequired, LIMITS[key]) };
  });
}
function createPlan({ scope, databaseName, categories }) {
  if (!Object.hasOwn(DATABASES, scope) || databaseName !== DATABASES[scope] || !Array.isArray(categories) || categories.length > 1000)
    fail('DURATION_SCOPE_INVALID');
  const operations = [], ids = new Set();
  for (const row of categories) {
    if (!inScope(row, scope) || row.isActive !== true || row.isVip !== false || row.accessGate?.type !== 'ad_reward') continue;
    const id = String(row._id);
    if (!/^[a-f0-9]{24}$/.test(id) || ids.has(id)) fail('DURATION_CATEGORY_INVALID');
    ids.add(id);
    const nextOptions = optionsFor(row);
    if (!isDeepStrictEqual(nextOptions, row.accessGate.options)) operations.push({ id, before: critical(row), nextOptions });
  }
  operations.sort((a, b) => a.id.localeCompare(b.id));
  const plan = { version: VERSION, scope, databaseName, limits: LIMITS, operations,
    categoriesExamined: ids.size, userProgressModified: false, paidEntitlementsModified: false,
    wheelAndAffiliateModified: false, weeklyJournalCreditsModified: false, notificationsSent: false };
  return { ...plan, planHash: hash(plan) };
}
function verifyPlan(plan, confirmHash) {
  const { planHash, ...body } = plan || {};
  if (!/^[a-f0-9]{64}$/.test(confirmHash || '') || planHash !== confirmHash || hash(body) !== planHash)
    fail('DURATION_PLAN_HASH_MISMATCH');
  const rows = plan.operations?.map(op => ({ _id: op.id, ...op.before }));
  const expected = createPlan({ scope: plan.scope, databaseName: plan.databaseName, categories: rows });
  const { categoriesExamined: _expectedCount, planHash: _expectedHash, ...expectedBody } = expected;
  const { categoriesExamined, ...actualBody } = body;
  if (!Number.isSafeInteger(categoriesExamined) || categoriesExamined < rows.length || categoriesExamined > 1000 ||
      !isDeepStrictEqual(actualBody, expectedBody)) fail('DURATION_PLAN_SCOPE_INVALID');
  return plan;
}
async function applyPlan(db, client, plan, { confirmHash, objectId, mode = 'apply' }) {
  verifyPlan(plan, confirmHash);
  if (db.databaseName !== plan.databaseName || !['apply', 'rollback'].includes(mode) || typeof objectId !== 'function')
    fail('DURATION_APPLY_SCOPE_INVALID');
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') fail('DURATION_TRANSACTION_REQUIRED');
  const session = client.startSession(); let changed = 0, skipped = 0;
  try {
    await session.withTransaction(async () => {
      changed = 0; skipped = 0;
      const collection = db.collection('categories');
      for (const op of plan.operations) {
        const after = { ...op.before, accessGate: { ...op.before.accessGate, options: op.nextOptions } };
        const before = mode === 'apply' ? op.before : after;
        const desired = mode === 'apply' ? after : op.before;
        const current = await collection.findOne({ _id: objectId(op.id) }, { session, maxTimeMS: 5000 });
        if (!current) fail('DURATION_CATEGORY_MISSING');
        if (isDeepStrictEqual(critical(current), desired)) { skipped++; continue; }
        if (!isDeepStrictEqual(critical(current), before)) fail('DURATION_STALE_PLAN');
        const clauses = [{ _id: objectId(op.id) }, ...GUARDS.map(key => Object.hasOwn(before, key)
          ? { [key]: { $eq: before[key] } } : { [key]: { $exists: false } })];
        const result = await collection.updateOne({ $and: clauses },
          { $set: { 'accessGate.options': desired.accessGate.options } }, { session, maxTimeMS: 5000 });
        if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('DURATION_CAS_REFUSED');
        changed++;
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
  } finally { await session.endSession(); }
  return { version: VERSION, mode, scope: plan.scope, databaseName: plan.databaseName, planHash: plan.planHash,
    changed, skipped, userProgressModified: false, paidEntitlementsModified: false,
    wheelAndAffiliateModified: false, weeklyJournalCreditsModified: false, notificationsSent: false };
}
module.exports = { APPS, LIMITS, DATABASES, GUARDS, hash, critical, createPlan, verifyPlan, applyPlan };
