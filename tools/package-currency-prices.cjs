#!/usr/bin/env node
'use strict';
// Frozen, explicit catalogue prices. No application bootstrap or FX network call.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = 'wintips-missing-currency-prices-v1';
const REFERENCE_SHA256 = '11e0e8576e61097de9b9194b0bfc26dce4a7241d7a2e9143150e4caa87a73a9c';
const CURRENCIES = ['XAF', 'XOF', 'EUR', 'USD', 'GMD', 'CDF', 'GNF', 'NGN', 'KES', 'GHS', 'TZS', 'UGX', 'ZAR', 'ZMW', 'MWK', 'RWF', 'SLE', 'MZN', 'LSL'];
const SPECS = [
  { id: 'c97d577e0912523aab9f1bfb', key: 'essentiel_7d', name: 'Essentiel', days: 7, cfa: 3500, usd: 10, eur: 10.99,
    sku: 'com.wintips.essentiel_7days_v1', categories: ['693d4774aacdc474fb9d2676', '693d4797aacdc474fb9d2677'] },
  { id: 'b8a93410f46646438cbace02', key: 'premium_14d', name: 'Premium', days: 14, cfa: 7000, usd: 21, eur: 22.99,
    sku: 'com.wintips.premium_14days_v1', categories: ['693d4774aacdc474fb9d2676', '693d4797aacdc474fb9d2677', '693d483baacdc474fb9d2679', '693d47d0aacdc474fb9d2678'] },
];
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (typeof value === 'number' && !Number.isFinite(value)) fail('NONFINITE_JSON');
  return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const bytesHash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => String(value?.$oid || value);
const encode = value => require('mongoose').mongo.BSON.EJSON.serialize(value, { relaxed: true });
const decode = value => require('mongoose').mongo.BSON.EJSON.deserialize(value, { relaxed: true });
const oid = value => new (require('mongoose').Types.ObjectId)(value);

function reference(raw) {
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
  if (raw.length > 100000 || bytesHash(raw) !== REFERENCE_SHA256) fail('EXACT_APPROVED_RATE_BYTES_REQUIRED');
  const value = JSON.parse(raw.toString('utf8'));
  if (value.result !== 'success' || value.base_code !== 'XAF' || value.provider !== 'https://www.exchangerate-api.com' ||
      !Number.isSafeInteger(value.time_last_update_unix) || value.rates?.XAF !== 1 || value.rates?.XOF !== 1) fail('INVALID_RATE_REFERENCE');
  const rates = {};
  for (const code of CURRENCIES) {
    const rate = value.rates[code], exact = String(rate);
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1e9 || !/^\d+(?:\.\d{1,12})?$/.test(exact)) fail('RATE_MISSING_OR_UNSAFE');
    rates[code] = exact;
  }
  return { sha256: bytesHash(raw), rawBase64: raw.toString('base64'), provider: value.provider,
    lastUpdatedAtUtc: new Date(value.time_last_update_unix * 1000).toISOString(), rates };
}
function roundPrice(base, rate) {
  if (!Number.isSafeInteger(base) || base <= 0 || !/^\d+(?:\.\d{1,12})?$/.test(String(rate))) fail('INVALID_DECIMAL_CONVERSION');
  const [whole, fraction = ''] = String(rate).split('.');
  const numerator = BigInt(whole + fraction), denominator = 10n ** BigInt(fraction.length);
  const rounded = (BigInt(base) * numerator * 2n + denominator) / (2n * denominator);
  if (rounded < 1n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail('CONVERTED_PRICE_OUT_OF_BOUNDS');
  return Number(rounded);
}
function priceProjection(pricing, spec, ref) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) fail('EXPLICIT_PRICING_REQUIRED');
  const out = { ...pricing }, added = [];
  for (const [code, amount] of Object.entries(pricing)) {
    if (!/^[A-Z]{3}$/.test(code) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) fail('EXISTING_PRICE_INVALID');
  }
  if (pricing.XAF !== spec.cfa || pricing.XOF !== spec.cfa || pricing.USD !== spec.usd || pricing.EUR !== spec.eur) fail('PROTECTED_EXPLICIT_PRICES_CHANGED');
  for (const code of CURRENCIES) {
    if (Object.hasOwn(out, code)) continue;
    out[code] = roundPrice(spec.cfa, ref.rates[code]); added.push(code);
  }
  return { pricing: out, added };
}
function provenance(spec, code, amount, ref) {
  return { kind: 'fixed_xaf_conversion', baseCurrency: 'XAF', baseAmount: spec.cfa, currency: code, amount,
    ratePerXaf: ref.rates[code], provider: ref.provider, referenceSha256: ref.sha256,
    referenceUpdatedAtUtc: ref.lastUpdatedAtUtc, rounding: 'nearest_whole_half_up',
    checkoutConversion: false, fixedUntilExplicitlyEdited: true };
}
function assertPackage(doc, spec) {
  if (!doc || id(doc._id) !== spec.id || doc.catalogueKey !== 'wintips-rdj-catalogue-v1:package:' + spec.key ||
      doc.isActive !== true || doc.paymentMode !== 'money' || doc.duration !== spec.days ||
      doc.googleProductId !== spec.sku || doc.googleProductType !== 'ONE_TIME_PRODUCT' || doc.availableOnGooglePlay !== true ||
      hash((doc.categories || []).map(id).sort()) !== hash([...spec.categories].sort())) fail('TARGET_PACKAGE_IDENTITY_OR_RIGHTS_CHANGED');
  if (doc.pricingProvenance !== undefined && (!doc.pricingProvenance || typeof doc.pricingProvenance !== 'object' || Array.isArray(doc.pricingProvenance))) fail('PRICING_PROVENANCE_NOT_OBJECT');
}
function makePlan(state, rawReference, { now = () => new Date() } = {}) {
  if (state.databaseName !== 'wintips' || !Array.isArray(state.packages) || state.packages.length > 100 ||
      new Set(state.packages.map(p => id(p._id))).size !== state.packages.length) fail('EXPECTED_WINTIPS_CATALOGUE_REQUIRED');
  const active = state.packages.filter(p => p.isActive === true).map(p => id(p._id)).sort();
  if (hash(active) !== hash(SPECS.map(p => p.id).sort())) fail('EXACT_TWO_ACTIVE_PACKAGES_REQUIRED');
  const ref = reference(rawReference), stamp = now();
  const age = stamp.getTime() - Date.parse(ref.lastUpdatedAtUtc);
  if (!Number.isFinite(age) || age < 0 || age > 48 * 3600000) fail('RATE_REFERENCE_NOT_FRESH_AT_PLANNING');
  const operations = SPECS.map(spec => {
    const before = state.packages.find(p => id(p._id) === spec.id); assertPackage(before, spec);
    const projected = priceProjection(before.pricing, spec, ref), after = clone(before);
    after.pricing = projected.pricing;
    if (projected.added.length) {
      after.pricingProvenance = { ...(before.pricingProvenance || {}) };
      for (const code of projected.added) {
        // Existing metadata is preserved too; an orphan currency provenance
        // requires explicit review rather than silently replacing its meaning.
        if (Object.hasOwn(after.pricingProvenance, code)) fail('EXISTING_ORPHAN_PRICE_PROVENANCE');
        after.pricingProvenance[code] = provenance(spec, code, after.pricing[code], ref);
      }
    }
    return { id: spec.id, before: clone(before), after, addedCurrencies: projected.added,
      beforeHash: hash(before), afterHash: hash(after) };
  });
  const plan = { version: VERSION, appId: 'wintips', databaseName: 'wintips', preparedAtUtc: stamp.toISOString(),
    expiresAtUtc: new Date(Date.parse(ref.lastUpdatedAtUtc) + 48 * 3600000).toISOString(), currencies: [...CURRENCIES],
    reference: ref, operations, protectedOtherPackages: state.packages.filter(p => !SPECS.some(s => s.id === id(p._id)))
      .map(p => ({ id: id(p._id), sha256: hash(p) })).sort((a, b) => a.id.localeCompare(b.id)),
    subscriptionWrites: 0, transactionWrites: 0, categoryWrites: 0, googleMutations: 0,
    conversionAtCheckout: false, purchasedRightsUnchanged: true };
  return { ...plan, planHash: hash(plan) };
}
function verifyPlan(plan, confirmedHash) {
  const unsigned = { ...plan }; delete unsigned.planHash;
  if (!confirmedHash || confirmedHash !== plan?.planHash || hash(unsigned) !== confirmedHash || plan.version !== VERSION ||
      plan.appId !== 'wintips' || plan.databaseName !== 'wintips' || plan.operations?.length !== 2 ||
      hash(plan.currencies) !== hash(CURRENCIES)) fail('EXACT_PRICE_PLAN_REQUIRED');
  const reconstructed = makePlan({ databaseName: plan.databaseName, packages: plan.operations.map(op => op.before) },
    Buffer.from(plan.reference.rawBase64, 'base64'), { now: () => new Date(plan.preparedAtUtc) });
  for (const key of ['reference', 'operations', 'expiresAtUtc', 'subscriptionWrites', 'transactionWrites', 'categoryWrites', 'googleMutations', 'conversionAtCheckout', 'purchasedRightsUnchanged']) {
    if (hash(plan[key]) !== hash(reconstructed[key])) fail('PRICE_PLAN_SCOPE_INVALID');
  }
  if (!Array.isArray(plan.protectedOtherPackages) || new Set(plan.protectedOtherPackages.map(p => p.id)).size !== plan.protectedOtherPackages.length ||
      plan.protectedOtherPackages.some(p => !/^[a-f0-9]{24}$/.test(p.id) || !/^[a-f0-9]{64}$/.test(p.sha256) || SPECS.some(s => s.id === p.id))) fail('PROTECTED_PACKAGES_INVALID');
  return plan;
}
async function readState(db, session) {
  if (db.databaseName !== 'wintips') fail('WRONG_DATABASE');
  const packages = await db.collection('packages').find({}, { session, maxTimeMS: 5000 }).limit(101).toArray();
  if (packages.length > 100) fail('CATALOGUE_EXCEEDS_REVIEW_BOUND');
  return { databaseName: db.databaseName, packages: encode(packages) };
}
function assertProtection(state, plan) {
  const expected = [...plan.operations.map(op => op.id), ...plan.protectedOtherPackages.map(p => p.id)].sort();
  if (hash(state.packages.map(p => id(p._id)).sort()) !== hash(expected) ||
      plan.protectedOtherPackages.some(p => !state.packages.some(doc => id(doc._id) === p.id && hash(doc) === p.sha256))) fail('OTHER_PACKAGE_DRIFT');
}
async function transaction(db, client, work) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') fail('MONGO_TRANSACTIONS_REQUIRED');
  const session = client.startSession();
  try { return await session.withTransaction(() => work(session), {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000,
  }); } finally { await session.endSession(); }
}
function changes(op, restore = false) {
  const set = {}, unset = {};
  for (const code of op.addedCurrencies) {
    if (restore) { unset['pricing.' + code] = ''; unset['pricingProvenance.' + code] = ''; }
    else { set['pricing.' + code] = op.after.pricing[code]; set['pricingProvenance.' + code] = op.after.pricingProvenance[code]; }
  }
  if (restore && op.before.pricingProvenance === undefined && op.addedCurrencies.length) {
    for (const key of Object.keys(unset)) if (key.startsWith('pricingProvenance.')) delete unset[key];
    unset.pricingProvenance = '';
  }
  return { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
}
async function applyPlan({ db, client, plan, confirmedHash, intent = false, now = () => new Date() }) {
  if (!intent) fail('PRICE_MUTATION_NOT_CONFIRMED'); verifyPlan(plan, confirmedHash);
  const clock = now().getTime();
  if (db.databaseName !== plan.databaseName || !Number.isFinite(clock) || clock < Date.parse(plan.preparedAtUtc) || clock >= Date.parse(plan.expiresAtUtc)) fail('WRONG_DATABASE_OR_EXPIRED_PLAN');
  let applied = 0, skipped = 0;
  await transaction(db, client, async session => {
    applied = 0; skipped = 0; const before = await readState(db, session); assertProtection(before, plan);
    for (const op of plan.operations) {
      const current = before.packages.find(doc => id(doc._id) === op.id);
      if (current && hash(current) === op.afterHash) { skipped++; continue; }
      if (!current || hash(current) !== op.beforeHash) fail('STALE_PRICE_PLAN');
      const result = await db.collection('packages').updateOne({ _id: oid(op.id) }, changes(op), { session });
      if (result.matchedCount !== 1) fail('PRICE_WRITE_NOT_MATCHED'); applied++;
    }
    const after = await readState(db, session); assertProtection(after, plan);
    if (plan.operations.some(op => !after.packages.some(doc => id(doc._id) === op.id && hash(doc) === op.afterHash))) fail('PRICE_POSTCONDITION_FAILED');
  });
  const receipt = { version: VERSION, appId: 'wintips', databaseName: db.databaseName, plan, applied, skipped,
    appliedAtUtc: now().toISOString(), subscriptionWrites: 0, transactionWrites: 0, categoryWrites: 0, googleMutations: 0,
    purchasedRightsUnchanged: true, rollbackRequiresExactAfterState: true };
  return { ...receipt, receiptHash: hash(receipt) };
}
async function rollback({ db, client, receipt, confirmedHash, intent = false }) {
  const unsigned = { ...receipt }; delete unsigned.receiptHash;
  if (!intent || !confirmedHash || receipt.receiptHash !== confirmedHash || hash(unsigned) !== confirmedHash ||
      receipt.version !== VERSION || receipt.appId !== 'wintips' || receipt.databaseName !== db.databaseName) fail('EXACT_ROLLBACK_RECEIPT_REQUIRED');
  const plan = verifyPlan(receipt.plan, receipt.plan.planHash); let restored = 0, skipped = 0;
  await transaction(db, client, async session => {
    restored = 0; skipped = 0; const state = await readState(db, session); assertProtection(state, plan);
    for (const op of [...plan.operations].reverse()) {
      const current = state.packages.find(doc => id(doc._id) === op.id);
      if (current && hash(current) === op.beforeHash) { skipped++; continue; }
      if (!current || hash(current) !== op.afterHash) fail('STALE_PRICE_ROLLBACK');
      const result = await db.collection('packages').updateOne({ _id: oid(op.id) }, changes(op, true), { session });
      if (result.matchedCount !== 1) fail('ROLLBACK_WRITE_NOT_MATCHED'); restored++;
    }
    const after = await readState(db, session); assertProtection(after, plan);
    if (plan.operations.some(op => !after.packages.some(doc => id(doc._id) === op.id && hash(doc) === op.beforeHash))) fail('ROLLBACK_POSTCONDITION_FAILED');
  });
  return { rolledBack: true, restored, skipped, subscriptionWrites: 0, transactionWrites: 0, googleMutations: 0 };
}
async function main(argv = process.argv.slice(2)) {
  let mode = 'plan'; const options = {}; let intent = false; const seen = new Set();
  const values = { '--rates-file': 'ratesFile', '--state-file': 'stateFile', '--plan-file': 'planFile', '--receipt-file': 'receiptFile', '--confirm-sha256': 'confirm', '--out': 'out' };
  const modes = argv.filter(a => ['--plan', '--apply', '--rollback'].includes(a));
  if (modes.length > 1) fail('ONE_MODE_REQUIRED');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) fail('DUPLICATE_ARGUMENT'); seen.add(arg);
    if (['--plan', '--apply', '--rollback'].includes(arg)) mode = arg.slice(2);
    else if (arg === '--confirm-price-mutation') intent = true;
    else if (values[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[values[arg]] = argv[++i];
    else fail('INVALID_ARGUMENT');
  }
  if (!argv.length) { process.stdout.write(JSON.stringify({ planOnly: true, connectsByDefault: false, version: VERSION, currencies: CURRENCIES, packageIds: SPECS.map(s => s.id), referenceSha256: REFERENCE_SHA256 }) + '\n'); return; }
  if (!options.out) fail('EXCLUSIVE_OUTPUT_REQUIRED');
  if (mode !== 'plan' && (!intent || options.stateFile || !/^[a-f0-9]{64}$/.test(options.confirm || ''))) fail('EXPLICIT_MUTATION_CONFIRMATION_REQUIRED');
  if ((mode === 'plan' && !options.ratesFile) || (mode === 'apply' && !options.planFile) || (mode === 'rollback' && !options.receiptFile)) fail('INPUT_FILE_REQUIRED');
  // Reserve the private backup/receipt before any database connection or write.
  const output = path.resolve(options.out); fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(output, 'wx', 0o600); let client;
  try {
    fs.writeSync(fd, JSON.stringify({ status: 'pending', mode, version: VERSION }) + '\n'); fs.fsyncSync(fd);
    let state, db, result;
    if (mode === 'plan' && options.stateFile) state = JSON.parse(fs.readFileSync(options.stateFile, 'utf8'));
    else {
      const uri = process.env.WINTIPS_PRICING_MONGO_URI;
      if (!uri) fail('EXPLICIT_WINTIPS_PRICING_MONGO_URI_REQUIRED');
      const { MongoClient } = require('mongoose').mongo; client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
      await client.connect(); db = client.db(); if (db.databaseName !== 'wintips') fail('WRONG_DATABASE');
      if (mode === 'plan') state = await readState(db);
    }
    if (mode === 'plan') result = makePlan(state, fs.readFileSync(options.ratesFile));
    else if (mode === 'apply') result = await applyPlan({ db, client, plan: JSON.parse(fs.readFileSync(options.planFile, 'utf8')), confirmedHash: options.confirm, intent });
    else result = await rollback({ db, client, receipt: JSON.parse(fs.readFileSync(options.receiptFile, 'utf8')), confirmedHash: options.confirm, intent });
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
    process.stdout.write(JSON.stringify({ mode, output, sha256: bytesHash(bytes), planHash: result.planHash, receiptHash: result.receiptHash,
      applied: result.applied, skipped: result.skipped, restored: result.restored, databaseWrites: mode === 'plan' ? 0 : result.applied ?? result.restored }) + '\n');
  } finally { fs.closeSync(fd); if (client) await client.close(); }
}
module.exports = { VERSION, REFERENCE_SHA256, CURRENCIES, SPECS, hash, reference, roundPrice, priceProjection, makePlan, verifyPlan, readState, applyPlan, rollback, changes, main };
if (require.main === module) main().catch(error => { process.stderr.write(JSON.stringify({ success: false, code: error.safeCode || 'PRICE_TOOL_FAILED' }) + '\n'); process.exitCode = 1; });
