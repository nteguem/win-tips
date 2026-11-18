#!/usr/bin/env node
'use strict';

// Plans and narrowly applies the confirmed BigWin provider/country mapping.
// Importing this module never connects to MongoDB or loads application services.
const crypto = require('node:crypto');
const VERSION = 'wintips-mobile-money-country-config-v1';
const DATABASE = 'wintips';
const COLLECTION = 'appconfigs';
const FIELDS = Object.freeze(['currency', 'paymentProvider', 'phonePrefix']);
const TARGETS = Object.freeze([
  ['CD', 'pawapay', 'CDF', '+243'],
  ['CG', 'pawapay', 'XAF', '+242'],
  ['CI', 'pawapay', 'XOF', '+225'],
  ['GA', 'pawapay', 'XAF', '+241'],
  ['GH', 'korapay', 'GHS', '+233'],
  ['KE', 'korapay', 'KES', '+254'],
  ['NG', 'korapay', 'NGN', '+234'],
  ['RW', 'pawapay', 'RWF', '+250'],
  ['SL', 'pawapay', 'SLE', '+232'],
  ['SN', 'pawapay', 'XOF', '+221'],
  ['UG', 'pawapay', 'UGX', '+256'],
  ['ZA', 'korapay', 'ZAR', '+27'],
  ['ZM', 'pawapay', 'ZMW', '+260'],
].map(([countryCode, paymentProvider, currency, phonePrefix]) =>
  Object.freeze({ countryCode, paymentProvider, currency, phonePrefix })));

function fail(code) {
  throw Object.assign(new Error(code), { safeCode: code });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (!Number.isFinite(value.getTime())) fail('INVALID_CONFIG_DATE');
    return { $date: value.toISOString() };
  }
  if (value && typeof value.toHexString === 'function') {
    return { $oid: value.toHexString() };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) fail('NONFINITE_CONFIG_VALUE');
  return value;
}
const clone = value => JSON.parse(JSON.stringify(canonical(value)));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function idOf(value) {
  const id = String(value?.$oid || value);
  if (!/^[a-f\d]{24}$/i.test(id)) fail('INVALID_COUNTRY_CONFIG_ID');
  return id.toLowerCase();
}

function activeCountries(values) {
  if (!Array.isArray(values) || values.some(code => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))) {
    fail('EXPLICIT_ACTIVE_PAWAPAY_COUNTRIES_REQUIRED');
  }
  const active = [...new Set(values)].sort();
  if (TARGETS.some(target => target.paymentProvider === 'pawapay' && !active.includes(target.countryCode))) {
    fail('TARGET_PAWAPAY_COUNTRY_NOT_ACTIVE');
  }
  return active;
}

function planCountryConfig(rows, activePawaCountries) {
  if (!Array.isArray(rows) || rows.length > 300) fail('BOUNDED_COUNTRY_CONFIG_SNAPSHOT_REQUIRED');
  const active = activeCountries(activePawaCountries);
  const ids = new Set();
  const countries = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.countryCode !== 'string') fail('INVALID_COUNTRY_CONFIG');
    const id = idOf(row._id);
    if (ids.has(id) || countries.has(row.countryCode.toUpperCase())) fail('DUPLICATE_COUNTRY_CONFIG');
    ids.add(id); countries.add(row.countryCode.toUpperCase());
  }
  const operations = TARGETS.map(target => {
    const row = rows.find(candidate => candidate.countryCode === target.countryCode);
    if (!row) fail('TARGET_COUNTRY_CONFIG_MISSING');
    if (FIELDS.some(field => typeof row[field] !== 'string' || row[field].length === 0)) {
      fail('TARGET_COUNTRY_CONFIG_VALUES_REQUIRED');
    }
    const before = clone(row);
    const after = { ...before };
    for (const field of FIELDS) after[field] = target[field];
    const changedFields = FIELDS.filter(field => before[field] !== after[field]);
    return {
      id: idOf(row._id), countryCode: target.countryCode, before, after,
      changedFields, beforeHash: hash(before), afterHash: hash(after),
    };
  });
  const plan = {
    version: VERSION, appId: 'wintips', databaseName: DATABASE, collection: COLLECTION,
    allowedFields: [...FIELDS], activePawaCountries: active,
    idSha256: hash(operations.map(op => ({ countryCode: op.countryCode, id: op.id }))),
    changedCount: operations.filter(op => op.changedFields.length > 0).length,
    operations,
    protectedOtherCountries: rows.filter(row => !TARGETS.some(target => target.countryCode === row.countryCode))
      .map(row => ({ id: idOf(row._id), countryCode: row.countryCode, sha256: hash(row) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    packageWrites: 0, priceWrites: 0, languageWrites: 0, subscriptionWrites: 0,
    transactionWrites: 0, inserts: 0, deletes: 0,
    requiresAppConfigRefresh: true,
  };
  return { ...plan, planHash: hash(plan) };
}

function verifyPlan(plan, confirmedHash) {
  const unsigned = { ...plan }; delete unsigned.planHash;
  if (!confirmedHash || confirmedHash !== plan?.planHash || hash(unsigned) !== confirmedHash ||
      plan.version !== VERSION || plan.appId !== 'wintips' || plan.databaseName !== DATABASE ||
      plan.collection !== COLLECTION || plan.operations?.length !== TARGETS.length) {
    fail('EXACT_COUNTRY_CONFIG_PLAN_REQUIRED');
  }
  const rebuilt = planCountryConfig(plan.operations.map(op => op.before), plan.activePawaCountries);
  for (const key of ['operations', 'allowedFields', 'idSha256', 'changedCount', 'packageWrites',
    'priceWrites', 'languageWrites', 'subscriptionWrites', 'transactionWrites', 'inserts', 'deletes',
    'requiresAppConfigRefresh']) {
    if (hash(plan[key]) !== hash(rebuilt[key])) fail('COUNTRY_CONFIG_PLAN_SCOPE_INVALID');
  }
  if (!Array.isArray(plan.protectedOtherCountries) ||
      new Set(plan.protectedOtherCountries.map(row => row.id)).size !== plan.protectedOtherCountries.length ||
      plan.protectedOtherCountries.some(row => !/^[a-f\d]{24}$/.test(row.id) ||
        !/^[a-f\d]{64}$/.test(row.sha256) || typeof row.countryCode !== 'string' ||
        TARGETS.some(target => target.countryCode === row.countryCode))) {
    fail('INVALID_PROTECTED_COUNTRY_CONFIGS');
  }
  return plan;
}

async function readRows(db, session) {
  if (db.databaseName !== DATABASE) fail('WRONG_COUNTRY_CONFIG_DATABASE');
  const rows = await db.collection(COLLECTION).find({}, { session, maxTimeMS: 5000 }).limit(301).toArray();
  if (rows.length > 300) fail('COUNTRY_CONFIG_SNAPSHOT_TOO_LARGE');
  return clone(rows);
}

function assertProtection(rows, plan) {
  const expectedIds = [...plan.operations.map(op => op.id), ...plan.protectedOtherCountries.map(row => row.id)].sort();
  if (hash(rows.map(row => idOf(row._id)).sort()) !== hash(expectedIds) ||
      plan.protectedOtherCountries.some(protectedRow => !rows.some(row =>
        idOf(row._id) === protectedRow.id && row.countryCode === protectedRow.countryCode &&
        hash(row) === protectedRow.sha256))) {
    fail('PROTECTED_COUNTRY_CONFIG_DRIFT');
  }
}

async function transaction(db, client, callback) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') fail('COUNTRY_CONFIG_TRANSACTIONS_REQUIRED');
  const session = client.startSession();
  try {
    return await session.withTransaction(() => callback(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000,
    });
  } finally { await session.endSession(); }
}

function optimisticOperation(op, restore, idFactory) {
  const before = restore ? op.after : op.before;
  const after = restore ? op.before : op.after;
  const filter = { _id: idFactory(op.id), countryCode: op.countryCode };
  for (const field of FIELDS) filter[field] = before[field];
  return { filter, update: { $set: Object.fromEntries(op.changedFields.map(field => [field, after[field]])) } };
}

async function applyPlan({ db, client, plan, confirmedHash, intent = false,
  activePawaCountries, idFactory = id => new (require('mongoose').Types.ObjectId)(id), now = () => new Date() }) {
  if (!intent) fail('COUNTRY_CONFIG_MUTATION_NOT_CONFIRMED');
  verifyPlan(plan, confirmedHash);
  // Refuse an apply based only on the older planning-time provider catalogue.
  activeCountries(activePawaCountries);
  if (db.databaseName !== DATABASE) fail('WRONG_COUNTRY_CONFIG_DATABASE');
  let applied = 0, skipped = 0;
  await transaction(db, client, async session => {
    applied = 0; skipped = 0;
    const before = await readRows(db, session); assertProtection(before, plan);
    for (const op of plan.operations) {
      const current = before.find(row => idOf(row._id) === op.id);
      if (current && hash(current) === op.afterHash) { skipped++; continue; }
      if (!current || hash(current) !== op.beforeHash) fail('STALE_COUNTRY_CONFIG_PLAN');
      const write = optimisticOperation(op, false, idFactory);
      const result = await db.collection(COLLECTION).updateOne(write.filter, write.update, { session, upsert: false });
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('COUNTRY_CONFIG_WRITE_NOT_MATCHED');
      applied++;
    }
    const after = await readRows(db, session); assertProtection(after, plan);
    if (plan.operations.some(op => !after.some(row => idOf(row._id) === op.id && hash(row) === op.afterHash))) {
      fail('COUNTRY_CONFIG_POSTCONDITION_FAILED');
    }
  });
  const receipt = {
    version: VERSION, appId: 'wintips', databaseName: DATABASE, collection: COLLECTION,
    plan, applied, skipped, activePawaCountriesAtApply: [...new Set(activePawaCountries)].sort(),
    appliedAtUtc: now().toISOString(), packageWrites: 0, priceWrites: 0, languageWrites: 0,
    subscriptionWrites: 0, transactionWrites: 0, inserts: 0, deletes: 0,
    rollbackRequiresExactAfterState: true, requiresAppConfigRefresh: true,
  };
  return { ...receipt, receiptHash: hash(receipt) };
}

function verifyReceipt(receipt, confirmedHash) {
  const unsigned = { ...receipt }; delete unsigned.receiptHash;
  if (!confirmedHash || confirmedHash !== receipt?.receiptHash || hash(unsigned) !== confirmedHash ||
      receipt.version !== VERSION || receipt.appId !== 'wintips' || receipt.databaseName !== DATABASE ||
      receipt.collection !== COLLECTION) fail('EXACT_COUNTRY_CONFIG_ROLLBACK_RECEIPT_REQUIRED');
  verifyPlan(receipt.plan, receipt.plan.planHash);
  return receipt;
}

function rollbackOperations(receipt, confirmedHash, { idFactory = id => id } = {}) {
  verifyReceipt(receipt, confirmedHash);
  return [...receipt.plan.operations].reverse().filter(op => op.changedFields.length > 0)
    .map(op => optimisticOperation(op, true, idFactory));
}

async function rollback({ db, client, receipt, confirmedHash, intent = false,
  idFactory = id => new (require('mongoose').Types.ObjectId)(id), now = () => new Date() }) {
  if (!intent) fail('COUNTRY_CONFIG_ROLLBACK_NOT_CONFIRMED');
  verifyReceipt(receipt, confirmedHash);
  if (db.databaseName !== DATABASE) fail('WRONG_COUNTRY_CONFIG_DATABASE');
  const plan = receipt.plan;
  let restored = 0, skipped = 0;
  await transaction(db, client, async session => {
    restored = 0; skipped = 0;
    const before = await readRows(db, session); assertProtection(before, plan);
    for (const op of [...plan.operations].reverse()) {
      const current = before.find(row => idOf(row._id) === op.id);
      if (current && hash(current) === op.beforeHash) { skipped++; continue; }
      if (!current || hash(current) !== op.afterHash) fail('STALE_COUNTRY_CONFIG_ROLLBACK');
      const write = optimisticOperation(op, true, idFactory);
      const result = await db.collection(COLLECTION).updateOne(write.filter, write.update, { session, upsert: false });
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail('COUNTRY_CONFIG_ROLLBACK_NOT_MATCHED');
      restored++;
    }
    const after = await readRows(db, session); assertProtection(after, plan);
    if (plan.operations.some(op => !after.some(row => idOf(row._id) === op.id && hash(row) === op.beforeHash))) {
      fail('COUNTRY_CONFIG_ROLLBACK_POSTCONDITION_FAILED');
    }
  });
  const result = { version: VERSION, sourceReceiptHash: confirmedHash, restored, skipped,
    restoredAtUtc: now().toISOString(), packageWrites: 0, priceWrites: 0, languageWrites: 0 };
  return { ...result, rollbackHash: hash(result) };
}

module.exports = { VERSION, DATABASE, COLLECTION, FIELDS, TARGETS, hash, planCountryConfig,
  verifyPlan, readRows, optimisticOperation, applyPlan, verifyReceipt, rollbackOperations, rollback };

if (require.main === module) {
  runCli().catch(error => {
    // Never print driver errors: they can contain credentials or connection URIs.
    process.stderr.write((error.safeCode || 'COUNTRY_CONFIG_OPERATION_FAILED') + '\n');
    process.exitCode = 1;
  });
}

async function runCli() {
  const fs = require('node:fs');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const action = args.shift();
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') { options.apply = true; continue; }
    if (!['--plan', '--receipt', '--hash', '--out'].includes(key) || options[key] !== undefined || !args[i + 1]) {
      fail('INVALID_COUNTRY_CONFIG_ARGUMENTS');
    }
    options[key] = args[++i];
  }
  if (!['plan', 'apply', 'rollback'].includes(action) || !options['--out'] || !path.isAbsolute(options['--out'])) {
    fail('USAGE_PLAN_APPLY_OR_ROLLBACK_WITH_ABSOLUTE_OUT');
  }
  if (fs.existsSync(options['--out'])) fail('COUNTRY_CONFIG_OUTPUT_ALREADY_EXISTS');
  if (action !== 'plan' && (!options.apply || !options['--hash'])) fail('EXPLICIT_COUNTRY_CONFIG_APPLY_AND_HASH_REQUIRED');
  require('dotenv').config();
  const uri = process.env.WINTIPS_MOBILE_MONEY_MONGO_URI;
  if (!uri) fail('WINTIPS_MOBILE_MONEY_MONGO_URI_REQUIRED');
  const mongoose = require('mongoose');
  const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db(DATABASE);
    let result;
    if (action === 'rollback') {
      if (!options['--receipt']) fail('COUNTRY_CONFIG_RECEIPT_FILE_REQUIRED');
      const receipt = JSON.parse(fs.readFileSync(options['--receipt'], 'utf8'));
      result = await rollback({ db, client, receipt, confirmedHash: options['--hash'], intent: true });
    } else {
      const catalogue = await require('../src/api/services/user/PawapayService').getProvidersAsync();
      const activePawaCountries = catalogue.availableCountries;
      if (action === 'plan') result = planCountryConfig(await readRows(db), activePawaCountries);
      else {
        if (!options['--plan']) fail('COUNTRY_CONFIG_PLAN_FILE_REQUIRED');
        const plan = JSON.parse(fs.readFileSync(options['--plan'], 'utf8'));
        result = await applyPlan({ db, client, plan, activePawaCountries,
          confirmedHash: options['--hash'], intent: true });
      }
    }
    fs.writeFileSync(options['--out'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ action, planHash: result.planHash || result.plan?.planHash,
      receiptHash: result.receiptHash, rollbackHash: result.rollbackHash,
      changedCount: result.changedCount, applied: result.applied, restored: result.restored,
      requiresAppConfigRefresh: true }) + '\n');
  } finally { await client.close(); }
}
