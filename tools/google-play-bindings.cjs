#!/usr/bin/env node
// Bind only two reviewed, ACTIVE Play products to the already migrated packages.
// This tool never creates/activates products or writes purchases/subscriptions.
const fs = require('fs');
const path = require('path');
const { PACKAGE, SPECS, OLD_SKUS, hash, money, normalize } = require('./google-play-products.cjs');
const VERSION = 'wintips-google-bindings-v1';
const EXPECTED = [
  { ...SPECS[0], key: 'essentiel_7d', cfa: 3500, oldUsd: 6, oldEur: 5.34, categories: ['693d4774aacdc474fb9d2676', '693d4797aacdc474fb9d2677'] },
  { ...SPECS[1], key: 'premium_14d', cfa: 7000, oldUsd: 11.99, oldEur: 10.67, categories: ['693d4774aacdc474fb9d2676', '693d4797aacdc474fb9d2677', '693d483baacdc474fb9d2679', '693d47d0aacdc474fb9d2678'] },
];
const CATEGORIES = [
  { id: '693d4774aacdc474fb9d2676', name: { fr: 'Sélection Expert', en: 'Expert Selection' }, source: 'rdj_football_analysis' },
  { id: '693d4797aacdc474fb9d2677', name: { fr: 'Le Duo du Jour', en: 'The Daily Duo' }, source: 'rdj_football_duo' },
  { id: '693d483baacdc474fb9d2679', name: { fr: 'Combiné Buts', en: 'Goals Accumulator' }, source: 'rdj_football_goals' },
  { id: '693d47d0aacdc474fb9d2678', name: { fr: 'Expert Multisports', en: 'Multisports Expert' }, source: 'rdj_multisport_analysis' },
];
const ALLOWED = ['availableOnGooglePlay', 'googleProductId', 'googleProductType', 'pricing', 'pricingProvenance'];
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const encode = value => require('mongoose').mongo.BSON.EJSON.serialize(value, { relaxed: true });
const decode = value => require('mongoose').mongo.BSON.EJSON.deserialize(value, { relaxed: true });
const oid = value => new (require('mongoose').Types.ObjectId)(value);
const id = value => String(value?.$oid || value);
function cents(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) fail('EXPLICIT_EUR_PRICE_REQUIRED');
  const [whole, fraction = ''] = String(value).split('.');
  const n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (n <= 0n || n > 100000000n) fail('PRICE_OUT_OF_REVIEW_BOUND');
  return n;
}
function euroMoney(value) {
  const n = cents(value); return { currencyCode: 'EUR', units: String(n / 100n), nanos: Number(n % 100n) * 10000000 };
}
function summaryProduct(product, spec, euro) {
  if (!product || product.packageName !== PACKAGE || product.productId !== spec.id || product.purchaseOptions?.length !== 1) fail('PLAY_PRODUCT_IDENTITY_INVALID');
  const option = product.purchaseOptions[0];
  if (option.state !== 'ACTIVE' || !option.buyOption?.legacyCompatible || option.buyOption.multiQuantityEnabled === true || option.rentOption) fail('PLAY_PRODUCT_NOT_ACTIVE_SAFE_BUY');
  const rows = option.regionalPricingAndAvailabilityConfigs?.filter(row => row.availability === 'AVAILABLE') || [];
  const us = rows.find(row => row.regionCode === 'US'), fr = rows.find(row => row.regionCode === 'FR');
  if (!us || !fr || hash(money(us.price)) !== hash({ currencyCode: 'USD', units: spec.usd, nanos: 0 }) || hash(money(fr.price)) !== hash(euroMoney(euro))) fail('PLAY_US_OR_FR_PRICE_MISMATCH');
  // Regional taxes and price points may differ. US and FR are explicit catalogue
  // references, while native Billing remains the actual regional price source.
  for (const row of rows) money(row.price);
  const regionalCurrencyReview = {};
  for (const currency of ['USD', 'EUR']) {
    const values = rows.filter(row => row.price.currencyCode === currency).map(row => ({ regionCode: row.regionCode, price: money(row.price) })).sort((a, b) => a.regionCode.localeCompare(b.regionCode));
    regionalCurrencyReview[currency] = { uniform: new Set(values.map(row => hash(row.price))).size === 1, regions: values };
  }
  for (const [language, suffix, renewal] of [['fr', 'jours', /sans renouvellement automatique/i], ['en', 'days', /no automatic renewal/i]]) {
    const listing = (product.listings || []).find(row => row.languageCode?.startsWith(language));
    if (!listing || !new RegExp('\\b' + spec.days + '\\s*(?:' + suffix + ')\\b', 'i').test(listing.title) || !renewal.test(listing.description)) fail('PLAY_LISTING_DURATION_OR_RENEWAL_UNVERIFIED');
  }
  return { productId: spec.id, state: 'ACTIVE', purchaseOptionId: option.purchaseOptionId,
    normalizedProductHash: hash({ product: normalize(product), state: option.state }),
    US: money(us.price), FR: money(fr.price), availableRegions: rows.map(row => row.regionCode).sort(),
    eurRegions: rows.filter(row => row.price.currencyCode === 'EUR').map(row => row.regionCode).sort(),
    usdRegions: rows.filter(row => row.price.currencyCode === 'USD').map(row => row.regionCode).sort(), regionalCurrencyReview,
    googleGetUrl: 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + PACKAGE + '/oneTimeProducts/' + spec.id };
}
async function googleProof({ request, eurPrices, now = () => new Date() }) {
  const products = [];
  for (let i = 0; i < EXPECTED.length; i++) {
    const spec = EXPECTED[i]; euroMoney(eurPrices[i]);
    const response = await request({ method: 'GET', url: 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + PACKAGE + '/oneTimeProducts/' + spec.id, timeout: 15000, retry: false });
    if (response.status !== 200) fail('PLAY_GET_FAILED');
    products.push(summaryProduct(response.data, spec, eurPrices[i]));
  }
  return { packageName: PACKAGE, checkedAtUtc: now().toISOString(), readOnly: true, products };
}
async function readState(db, session) {
  const docs = await db.collection('packages').find({}, { session, maxTimeMS: 5000 }).limit(101).toArray();
  const categories = await db.collection('categories').find({}, { session, maxTimeMS: 5000, projection: { name: 1, editorialSource: 1, isVip: 1, isActive: 1 } }).limit(101).toArray();
  if (docs.length > 100 || categories.length > 100) fail('CATALOGUE_EXCEEDS_REVIEW_BOUND');
  return { databaseName: db.databaseName, packages: encode(docs), categories: encode(categories) };
}
function categoryProof(categories) {
  return CATEGORIES.map(spec => {
    const category = categories?.find(row => id(row._id || row.id) === spec.id);
    if (!category || hash(category.name) !== hash(spec.name) || category.editorialSource !== spec.source || category.isVip !== true || category.isActive !== true) fail('VIP_CATEGORY_METADATA_CHANGED');
    return { id: spec.id, name: category.name, editorialSource: category.editorialSource, isVip: true, isActive: true };
  });
}
function assertOnlyBindingFields(before, after) {
  const strip = value => Object.fromEntries(Object.entries(value).filter(([key]) => !ALLOWED.includes(key)));
  if (hash(strip(before)) !== hash(strip(after))) fail('NON_BINDING_FIELD_CHANGED');
  const stripPrices = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !['USD', 'EUR'].includes(key)));
  if (hash(stripPrices(before.pricing)) !== hash(stripPrices(after.pricing))) fail('OTHER_CURRENCY_CHANGED');
  const stripProvenance = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !['USD', 'EUR', 'googlePlayBinding'].includes(key)));
  if (hash(stripProvenance(before.pricingProvenance)) !== hash(stripProvenance(after.pricingProvenance))) fail('OTHER_PROVENANCE_CHANGED');
}
function makePlan(state, proof, eurPrices) {
  if (proof?.packageName !== PACKAGE || proof.products?.length !== 2 || proof.readOnly !== true) fail('PLAY_PROOF_REQUIRED');
  const categories = categoryProof(state.categories), operations = [];
  for (let i = 0; i < EXPECTED.length; i++) {
    const spec = EXPECTED[i], before = state.packages.find(row => id(row._id) === spec.packageId), evidence = proof.products.find(row => row.productId === spec.id);
    if (!before || !evidence || evidence.state !== 'ACTIVE' || before.catalogueKey !== 'wintips-rdj-catalogue-v1:package:' + spec.key || before.duration !== spec.days || before.isActive !== true || before.paymentMode !== 'money' ||
        hash((before.categories || []).map(id).sort()) !== hash([...spec.categories].sort()) || before.pricing?.XAF !== spec.cfa || before.pricing?.XOF !== spec.cfa) fail('PACKAGE_RIGHTS_OR_CFA_PRECONDITION_FAILED');
    // Planning a new activation must start from the reviewed unbound state.
    if (before.availableOnGooglePlay !== false || before.googleProductId !== null || before.googleProductType !== null || before.pricing.USD !== spec.oldUsd || before.pricing.EUR !== spec.oldEur) fail('PACKAGE_GOOGLE_OR_PRICE_PRECONDITION_FAILED');
    const eur = Number(cents(eurPrices[i])) / 100;
    if (hash(evidence.US) !== hash({ currencyCode: 'USD', units: spec.usd, nanos: 0 }) || hash(evidence.FR) !== hash(euroMoney(eurPrices[i]))) fail('PROOF_REFERENCE_PRICE_MISMATCH');
    const after = { ...before, availableOnGooglePlay: true, googleProductId: spec.id, googleProductType: 'ONE_TIME_PRODUCT',
      pricing: { ...before.pricing, USD: Number(spec.usd), EUR: eur },
      pricingProvenance: { ...(before.pricingProvenance || {}),
        USD: { kind: 'owner_explicit_google_play', amount: Number(spec.usd), source: evidence.googleGetUrl, checkoutConversion: false },
        EUR: { kind: 'google_play_fr_reference', amount: eur, source: evidence.googleGetUrl, checkoutConversion: false },
        googlePlayBinding: { productId: spec.id, packageName: PACKAGE, checkedAtUtc: proof.checkedAtUtc,
          productHash: evidence.normalizedProductHash, actualChargeVerified: false, regionalPricesMayDiffer: true } } };
    assertOnlyBindingFields(before, after);
    operations.push({ id: spec.packageId, before, after, beforeHash: hash(before), afterHash: hash(after) });
  }
  const plan = { version: VERSION, appId: 'wintips', packageName: PACKAGE, databaseName: state.databaseName,
    preparedAtUtc: proof.checkedAtUtc, eurPrices: eurPrices.map(value => Number(cents(value)) / 100), googleProof: proof, categoryProof: categories,
    protectedOtherPackages: state.packages.filter(row => !EXPECTED.some(spec => spec.packageId === id(row._id))).map(row => ({ id: id(row._id), sha256: hash(row) })).sort((a, b) => a.id.localeCompare(b.id)),
    operations, productMutations: 0, subscriptionWrites: 0, transactionWrites: 0 };
  plan.planHash = hash(plan); return plan;
}
function verifyPlan(plan, confirmedHash) {
  const unsigned = { ...plan }; delete unsigned.planHash;
  if (!confirmedHash || plan.planHash !== confirmedHash || hash(unsigned) !== confirmedHash || plan.version !== VERSION || plan.appId !== 'wintips' || plan.packageName !== PACKAGE || plan.operations?.length !== 2) fail('EXACT_BINDING_PLAN_REQUIRED');
  const before = { databaseName: plan.databaseName, packages: plan.operations.map(op => op.before), categories: plan.categoryProof };
  const reconstructed = makePlan(before, plan.googleProof, plan.eurPrices);
  if (hash(reconstructed.operations) !== hash(plan.operations)) fail('BINDING_OPERATIONS_INVALID');
  return plan;
}
async function inTransaction(db, client, work) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') fail('MONGO_TRANSACTIONS_REQUIRED');
  const session = client.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 }); }
  finally { await session.endSession(); }
}
function protectedMatch(state, protection) {
  return protection.every(row => state.packages.some(pkg => id(pkg._id) === row.id && hash(pkg) === row.sha256));
}
function setValues(document) {
  return { availableOnGooglePlay: document.availableOnGooglePlay, googleProductId: document.googleProductId, googleProductType: document.googleProductType,
    'pricing.USD': document.pricing.USD, 'pricing.EUR': document.pricing.EUR, pricingProvenance: decode(document.pricingProvenance) };
}
async function applyPlan({ db, client, request, plan, confirmedHash, intent = false }) {
  if (!intent) fail('BINDING_MUTATION_NOT_CONFIRMED'); verifyPlan(plan, confirmedHash);
  if (plan.databaseName !== db.databaseName) fail('DATABASE_MISMATCH');
  const fresh = await googleProof({ request, eurPrices: plan.eurPrices });
  if (hash(fresh.products) !== hash(plan.googleProof.products)) fail('PLAY_PRODUCT_CHANGED_AFTER_REVIEW');
  let applied = 0, skipped = 0;
  await inTransaction(db, client, async session => {
    applied = 0; skipped = 0; const state = await readState(db, session);
    if (hash(categoryProof(state.categories)) !== hash(plan.categoryProof)) fail('VIP_CATEGORY_METADATA_CHANGED');
    if (!protectedMatch(state, plan.protectedOtherPackages)) fail('OTHER_PACKAGE_DRIFT');
    for (const op of plan.operations) {
      const current = state.packages.find(row => id(row._id) === op.id);
      if (current && hash(current) === op.afterHash) { skipped++; continue; }
      if (!current || hash(current) !== op.beforeHash) fail('STALE_BINDING_PLAN');
      const result = await db.collection('packages').updateOne({ _id: oid(op.id) }, { $set: setValues(op.after) }, { session });
      if (result.matchedCount !== 1) fail('BINDING_WRITE_NOT_MATCHED'); applied++;
    }
    const after = await readState(db, session);
    if (!protectedMatch(after, plan.protectedOtherPackages) || plan.operations.some(op => !after.packages.some(row => id(row._id) === op.id && hash(row) === op.afterHash))) fail('BINDING_POSTCONDITION_FAILED');
  });
  const receipt = { version: VERSION, appId: 'wintips', databaseName: db.databaseName, packageName: PACKAGE, planHash: plan.planHash,
    applied, skipped, operations: plan.operations, protectedOtherPackages: plan.protectedOtherPackages, googleProof: fresh,
    productMutations: 0, subscriptionWrites: 0, transactionWrites: 0, purchasedRightsUnchanged: true, privateCommercialBackupOnly: true };
  return { ...receipt, receiptHash: hash(receipt) };
}
async function rollback({ db, client, receipt, confirmedHash, intent = false }) {
  const { receiptHash, ...unsigned } = receipt || {};
  if (!intent || receiptHash !== confirmedHash || hash(unsigned) !== confirmedHash || receipt.version !== VERSION || receipt.appId !== 'wintips' || receipt.packageName !== PACKAGE || receipt.databaseName !== db.databaseName || receipt.operations?.length !== 2) fail('EXACT_ROLLBACK_RECEIPT_REQUIRED');
  for (const op of receipt.operations) {
    if (!EXPECTED.some(spec => spec.packageId === op.id) || id(op.before._id) !== op.id || id(op.after._id) !== op.id || hash(op.before) !== op.beforeHash || hash(op.after) !== op.afterHash) fail('ROLLBACK_SCOPE_INVALID');
    assertOnlyBindingFields(op.before, op.after);
  }
  let restored = 0, skipped = 0;
  await inTransaction(db, client, async session => {
    restored = 0; skipped = 0;
    const state = await readState(db, session);
    for (const op of [...receipt.operations].reverse()) {
      const current = state.packages.find(row => id(row._id) === op.id);
      if (current && hash(current) === op.beforeHash) { skipped++; continue; }
      if (!current || hash(current) !== op.afterHash) fail('STALE_BINDING_ROLLBACK');
      await db.collection('packages').updateOne({ _id: oid(op.id) }, { $set: setValues(op.before) }, { session }); restored++;
    }
  });
  return { rolledBack: true, restored, skipped, productMutations: 0, subscriptionWrites: 0, transactionWrites: 0, purchasedRightsUnchanged: true };
}
async function main(argv = process.argv.slice(2)) {
  let mode = 'plan'; const options = {};
  const values = { '--essential-eur': 'essentialEur', '--premium-eur': 'premiumEur', '--plan-file': 'planFile', '--receipt-file': 'receiptFile', '--confirm-sha256': 'confirmedHash', '--out': 'out' };
  let modes = 0; const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) fail('DUPLICATE_ARGUMENT'); seen.add(key);
    if (['--plan', '--apply', '--rollback'].includes(key)) { mode = key.slice(2); modes++; }
    else if (key === '--confirm-google-bindings-mutation') options.intent = true;
    else if (values[key] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[values[key]] = argv[++i];
    else fail('UNKNOWN_OR_MISSING_ARGUMENT');
  }
  if (modes > 1 || !options.out) fail('ONE_MODE_AND_PRIVATE_OUTPUT_REQUIRED');
  if (mode !== 'plan' && (!options.intent || !options.confirmedHash || !(mode === 'apply' ? options.planFile : options.receiptFile))) fail('EXPLICIT_BINDING_INTENT_REQUIRED');
  if (mode === 'plan') { euroMoney(options.essentialEur); euroMoney(options.premiumEur); }
  const input = mode === 'plan' ? null : JSON.parse(fs.readFileSync(mode === 'apply' ? options.planFile : options.receiptFile, 'utf8'));
  const fd = fs.openSync(path.resolve(options.out), 'wx', 0o600); let connection;
  try {
    fs.writeFileSync(fd, JSON.stringify({ status: 'pending', mode, databaseMutationIntent: options.intent === true }) + '\n'); fs.fsyncSync(fd);
    if (!process.env.WINTIPS_CATALOGUE_MONGO_URI) fail('EXPLICIT_DATABASE_URI_REQUIRED');
    const mongoose = require('mongoose'); connection = await mongoose.createConnection(process.env.WINTIPS_CATALOGUE_MONGO_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 }).asPromise();
    if (connection.name !== 'wintips') fail('PRODUCTION_APP_DATABASE_MISMATCH');
    let request;
    if (mode !== 'rollback') {
      const env = { ...require('dotenv').parse(fs.readFileSync(path.resolve('.env'))), ...process.env };
      if (env.GOOGLE_PLAY_PACKAGE_NAME !== PACKAGE || !env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH) fail('GOOGLE_APP_UNCONFIGURED');
      const { google } = require('googleapis'); const client = await new google.auth.GoogleAuth({ keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH, scopes: ['https://www.googleapis.com/auth/androidpublisher'] }).getClient();
      request = config => client.request(config);
    }
    const common = { db: connection.db, client: connection.getClient(), request };
    const result = mode === 'plan' ? makePlan(await readState(common.db), await googleProof({ request, eurPrices: [options.essentialEur, options.premiumEur] }), [options.essentialEur, options.premiumEur]) :
      mode === 'apply' ? await applyPlan({ ...common, plan: input, confirmedHash: options.confirmedHash, intent: options.intent }) :
        await rollback({ ...common, receipt: input, confirmedHash: options.confirmedHash, intent: options.intent });
    fs.ftruncateSync(fd); fs.writeSync(fd, JSON.stringify(result, null, 2) + '\n', 0, 'utf8'); fs.fsyncSync(fd);
    process.stdout.write(JSON.stringify({ success: true, mode, output: path.resolve(options.out), planHash: result.planHash, receiptHash: result.receiptHash, applied: result.applied, restored: result.restored, productMutations: 0, subscriptionWrites: 0, transactionWrites: 0 }) + '\n'); return result;
  } finally { if (connection) await connection.close(); fs.closeSync(fd); }
}
module.exports = { VERSION, EXPECTED, CATEGORIES, cents, euroMoney, summaryProduct, googleProof, readState, categoryProof, makePlan, verifyPlan, applyPlan, rollback, main };
if (require.main === module) main().catch(error => { process.stdout.write(JSON.stringify({ success: false, errorCode: error.safeCode || 'PROVIDER_OR_DATABASE_FAILURE', providerHttpStatus: Number(error.response?.status) || null }) + '\n'); process.exitCode = 1; });
