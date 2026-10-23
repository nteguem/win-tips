#!/usr/bin/env node
// Standalone catalogue migration. Never imports application startup or jobs.
const fs = require('node:fs');
const path = require('node:path');
const { VERSION, createPlan, verifyPlan, hash, idOf } = require('../src/api/services/common/editorialCataloguePlan');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const codec = () => require('mongoose').mongo.BSON.EJSON;
const encode = value => codec().serialize(value, { relaxed: true });
const decode = value => codec().deserialize(value, { relaxed: true });
const objectId = value => new (require('mongoose').Types.ObjectId)(value);

async function readState(db) {
  const categories = await db.collection('categories').find({}, { maxTimeMS: 5000 }).limit(1001).toArray();
  const packages = await db.collection('packages').find({}, { maxTimeMS: 5000 }).limit(1001).toArray();
  if (categories.length > 1000 || packages.length > 1000) fail('REVIEW_LIMIT', 'Catalogue exceeds explicit review bound');
  const counts = await db.collection('subscriptions').aggregate([
    { $group: { _id: '$package', count: { $sum: 1 } } }, { $limit: 1001 },
  ], { maxTimeMS: 5000 }).toArray();
  if (counts.length > 1000) fail('REVIEW_LIMIT', 'Subscription package aggregate exceeds review bound');
  return { databaseName: db.databaseName, categories: encode(categories), packages: encode(packages),
    subscriptionCounts: Object.fromEntries(counts.filter(row => row._id).map(row => [String(row._id), row.count])) };
}

async function transaction(db, client, callback) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') fail('TRANSACTIONS_REQUIRED', 'Replica set or mongos required; no nontransactional fallback');
  const session = client.startSession();
  try { return await session.withTransaction(() => callback(session), {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000,
  }); } finally { await session.endSession(); }
}

async function applyPlan(db, client, plan, { confirmHash, intent = false } = {}) {
  if (!intent) fail('INTENT_REQUIRED', 'Explicit catalogue mutation confirmation required');
  verifyPlan(plan, confirmHash);
  if (plan.databaseName !== db.databaseName) fail('DATABASE_MISMATCH', 'Reviewed database does not match connection');
  let applied = [], skipped = [];
  await transaction(db, client, async session => {
    applied = []; skipped = [];
    for (const op of plan.operations) {
      if (idOf(op.after?._id) !== op.id || (op.before && idOf(op.before._id) !== op.id)) fail('PLAN_INVALID', 'Operation identity mismatch');
      const collection = db.collection(op.collection);
      const current = await collection.findOne({ _id: objectId(op.id) }, { session, maxTimeMS: 5000 });
      if (current && hash(encode(current)) === hash(op.after)) { skipped.push(op.id); continue; }
      if ((current ? hash(encode(current)) : null) !== (op.before ? hash(op.before) : null)) fail('STALE_PLAN', 'Catalogue changed since review; regenerate plan');
      if (op.reason === 'stop_legacy_sales_preserve_rights' && hash(op.after) !== hash({ ...op.before, isActive: false })) fail('PLAN_INVALID', 'Retirement must preserve all purchased package rights');
      if (op.collection === 'packages' && op.before && op.reason !== 'stop_legacy_sales_preserve_rights' && await db.collection('subscriptions').countDocuments({ package: objectId(op.id) }, { session, limit: 1, maxTimeMS: 5000 })) fail('PURCHASED_PACKAGE_IMMUTABLE', 'Purchased package cannot be rewritten');
      if (op.before) await collection.replaceOne({ _id: objectId(op.id) }, decode(op.after), { session });
      else await collection.insertOne(decode(op.after), { session });
      applied.push(op);
    }
  });
  const receipt = { version: VERSION, appId: 'wintips', databaseName: db.databaseName,
    planHash: plan.planHash, applied: applied.length, skipped: skipped.length,
    // Include exact reviewed before/after snapshots even on an idempotent
    // recovery. A lost first receipt can be regenerated from the same plan.
    operations: plan.operations, recoveredAlreadyApplied: skipped.length, targetCategoryIds: plan.targetCategoryIds,
    notificationsSent: false, entitledUsersModified: false, legacyRightsPreserved: true };
  return { ...receipt, receiptHash: hash(receipt) };
}

async function rollback(db, client, receipt, { confirmHash, intent = false } = {}) {
  const { receiptHash, ...body } = receipt || {};
  if (!intent || receipt?.version !== VERSION || receipt.appId !== 'wintips' || receipt.databaseName !== db.databaseName || hash(body) !== receiptHash || receiptHash !== confirmHash) fail('ROLLBACK_CONFIRMATION_REQUIRED', 'Exact original receipt and explicit rollback confirmation required');
  let restored = 0, disabled = 0;
  await transaction(db, client, async session => {
    restored = 0; disabled = 0;
    const touchedCategories = receipt.operations.filter(op => op.collection === 'categories').map(op => objectId(op.id));
    const purchasedTargets = receipt.operations.filter(op => op.collection === 'packages' && op.reason !== 'stop_legacy_sales_preserve_rights').map(op => objectId(op.id));
    if ((touchedCategories.length && await db.collection('editorialitems').countDocuments({ categoryId: { $in: touchedCategories } }, { session, limit: 1, maxTimeMS: 5000 })) ||
        (purchasedTargets.length && await db.collection('subscriptions').countDocuments({ package: { $in: purchasedTargets } }, { session, limit: 1, maxTimeMS: 5000 }))) fail('ROLLBACK_REQUIRES_REVIEW', 'Content or purchased target rights exist; stop worker and review manually, no data removed');
    // Rollback never deletes documents. Newly created catalogue entries are
    // withdrawn from sale/display; adopted entries regain their prior fields.
    for (const op of [...receipt.operations].reverse()) {
      if (!['categories', 'packages'].includes(op.collection)) fail('PLAN_INVALID', 'Unknown collection');
      const collection = db.collection(op.collection), current = await collection.findOne({ _id: objectId(op.id) }, { session, maxTimeMS: 5000 });
      const desired = op.before || { ...op.after, isActive: false };
      if (current && hash(encode(current)) === hash(desired)) continue;
      if (!current || hash(encode(current)) !== hash(op.after)) fail('STALE_ROLLBACK', 'Catalogue changed after application; no rollback writes');
      await collection.replaceOne({ _id: objectId(op.id) }, decode(desired), { session });
      if (op.before) restored++; else disabled++;
    }
  });
  return { version: VERSION, rolledBack: true, restored, disabled, deleted: 0, notificationsSent: false, entitledUsersModified: false };
}

function parseArgs(argv) {
  const result = { mode: 'plan', config: path.join(__dirname, 'editorial-catalogue.example.json') };
  const values = { '--config': 'config', '--plan-file': 'planFile', '--receipt-file': 'receiptFile', '--out': 'out', '--confirm-sha256': 'confirmHash' };
  const modes = argv.filter(arg => ['--plan', '--apply', '--rollback'].includes(arg));
  if (modes.length > 1) fail('ARGUMENTS', 'Choose one mode');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--plan', '--apply', '--rollback'].includes(arg)) result.mode = arg.slice(2);
    else if (arg === '--confirm-catalogue-mutation') result.intent = true;
    else if (values[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) result[values[arg]] = argv[++i];
    else fail('ARGUMENTS', 'Unknown or missing argument');
  }
  if (result.mode === 'apply' && (!result.intent || !result.confirmHash || !result.planFile)) fail('INTENT_REQUIRED', 'Apply requires reviewed plan, SHA and confirmation flag');
  if (result.mode === 'rollback' && (!result.intent || !result.confirmHash || !result.receiptFile)) fail('INTENT_REQUIRED', 'Rollback requires original receipt, SHA and confirmation flag');
  return result;
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  // Reserve the receipt before connecting or mutating. A process crash leaves
  // an explicit pending marker, never an unexplained successful output file.
  let outputFd;
  if (options.out) {
    outputFd = fs.openSync(options.out, 'wx');
    fs.writeFileSync(outputFd, JSON.stringify({ status: 'pending', mode: options.mode, databaseMutationConfirmed: false }) + '\n');
    fs.fsyncSync(outputFd);
  }
  // No automatic .env discovery, production defaults or URI command-line
  // values. Operator supplies the intended URI only through this env variable.
  let connection;
  try {
    const uri = process.env.WINTIPS_CATALOGUE_MONGO_URI;
    if (!uri) fail('DATABASE_REQUIRED', 'WINTIPS_CATALOGUE_MONGO_URI required');
    const mongoose = require('mongoose');
    connection = await mongoose.createConnection(uri, { autoCreate: false, autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 }).asPromise();
    const db = connection.db, client = connection.getClient();
    const result = options.mode === 'plan' ? createPlan(await readState(db), JSON.parse(fs.readFileSync(options.config, 'utf8'))) :
      options.mode === 'apply' ? await applyPlan(db, client, JSON.parse(fs.readFileSync(options.planFile, 'utf8')), options) :
      await rollback(db, client, JSON.parse(fs.readFileSync(options.receiptFile, 'utf8')), options);
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (outputFd !== undefined) { fs.ftruncateSync(outputFd, 0); fs.writeSync(outputFd, serialized, 0, 'utf8'); fs.fsyncSync(outputFd); }
    console.log(options.out ? JSON.stringify({ mode: options.mode, output: path.resolve(options.out), planHash: result.planHash, receiptHash: result.receiptHash, applied: result.applied, notificationsSent: false }) : serialized);
  } finally { if (connection) await connection.close(); if (outputFd !== undefined) fs.closeSync(outputFd); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ success: false, code: String(error.code || error.name || 'ERROR') })); process.exitCode = 1; });
module.exports = { readState, applyPlan, rollback, parseArgs, main };
