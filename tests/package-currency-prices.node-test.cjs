const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const tool = require('../tools/package-currency-prices.cjs');
const { priceFor, canPurchaseInCurrency } = require('../src/api/services/common/packagePricing');
const raw = fs.readFileSync(path.join(__dirname, 'fixtures/xaf-exchange-reference-20261024.json'));
const clock = () => new Date('2026-10-24T08:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
function state() {
  return { databaseName: 'wintips', packages: tool.SPECS.map(s => ({ _id: { $oid: s.id },
    catalogueKey: 'wintips-rdj-catalogue-v1:package:' + s.key,
    name: { fr: s.name, en: s.name === 'Essentiel' ? 'Essential' : 'Premium' },
    description: { fr: 'Description originale', en: 'Original description' },
    isActive: true, paymentMode: 'money', duration: s.days, categories: s.categories.map($oid => ({ $oid })),
    googleProductId: s.sku, googleProductType: 'ONE_TIME_PRODUCT', availableOnGooglePlay: true,
    pricing: { XAF: s.cfa, XOF: s.cfa, USD: s.usd, EUR: s.eur },
    pricingProvenance: { googlePlayBinding: { regionalPricesMayDiffer: true, actualChargeVerified: false }, owner: 'preserved' },
    createdAt: { $date: '2026-10-23T20:00:00Z' }, __v: 0,
  })).concat(Array.from({ length: 6 }, (_, i) => ({ _id: { $oid: String(i + 1).repeat(24) },
    isActive: false, name: { fr: 'Historique ' + i }, pricing: { CDF: 12500 + i, XAF: 2500 + i },
    duration: 30, categories: [], googleProductId: 'OLD_SKU_' + i }))) };
}
const plan = input => tool.makePlan(input || state(), raw, { now: clock });
const resign = value => { delete value.planHash; value.planHash = tool.hash(value); return value; };

test('frozen reference exact bytes, timestamp and decimal rates are recorded', () => {
  const ref = tool.reference(raw); assert.equal(ref.sha256, tool.REFERENCE_SHA256);
  assert.equal(ref.lastUpdatedAtUtc, '2026-10-24T00:02:31.000Z'); assert.equal(ref.rates.CDF, '3.969578');
  assert.deepEqual(Buffer.from(ref.rawBase64, 'base64'), raw);
  assert.throws(() => tool.reference(Buffer.concat([raw, Buffer.from('\n')])), /EXACT_APPROVED_RATE_BYTES_REQUIRED/);
});

test('all 19 fixed prices use separate exact decimal calculations and preserve four explicit prices', () => {
  const p = plan(); tool.verifyPlan(p, p.planHash);
  const expected = [
    { XAF: 3500, XOF: 3500, EUR: 10.99, USD: 10, GMD: 447, CDF: 13894, GNF: 52887, NGN: 7958, KES: 777, GHS: 70, TZS: 15702, UGX: 24927, ZAR: 99, ZMW: 121, MWK: 10449, RWF: 8853, SLE: 137, MZN: 382, LSL: 99 },
    { XAF: 7000, XOF: 7000, EUR: 22.99, USD: 21, GMD: 893, CDF: 27787, GNF: 105774, NGN: 15917, KES: 1553, GHS: 139, TZS: 31404, UGX: 49854, ZAR: 198, ZMW: 241, MWK: 20898, RWF: 17706, SLE: 275, MZN: 764, LSL: 198 },
  ];
  assert.equal(p.protectedOtherPackages.length, 6);
  for (const [index, op] of p.operations.entries()) {
    assert.deepEqual(op.after.pricing, expected[index]); assert.equal(op.addedCurrencies.length, 15);
    assert.ok(Object.values(op.after.pricing).every(value => value > 0));
    const before = clone(op.before), after = clone(op.after); delete before.pricing; delete after.pricing;
    delete before.pricingProvenance; delete after.pricingProvenance; assert.deepEqual(after, before);
    for (const [key, value] of Object.entries(op.before.pricingProvenance)) assert.deepEqual(op.after.pricingProvenance[key], value);
    assert.equal(op.after.pricingProvenance.CDF.checkoutConversion, false);
    assert.equal(op.after.pricingProvenance.CDF.referenceSha256, tool.REFERENCE_SHA256);
    assert.equal(op.after.pricingProvenance.CDF.ratePerXaf, '3.969578');
  }
});

test('rounding is whole-unit half up without binary floating-point or zero prices', () => {
  assert.equal(tool.roundPrice(1, '1.5'), 2); assert.equal(tool.roundPrice(1, '1.499999999999'), 1);
  assert.equal(tool.roundPrice(3500, '3.969578'), 13894); assert.equal(tool.roundPrice(7000, '3.969578'), 27787);
  for (const [base, rate] of [[1, '0.01'], [0, '1'], [1, '-1'], [1, '1e3'], [1, '1.0000000000001'], [Number.MAX_SAFE_INTEGER, '2']]) assert.throws(() => tool.roundPrice(base, rate));
});

test('existing explicit CDF and unknown currency prices and their provenance are never replaced', () => {
  const s = state(); s.packages[0].pricing.CDF = 20000; s.packages[0].pricing.JPY = 777;
  s.packages[0].pricingProvenance.CDF = { owner: 'explicit' };
  const p = plan(s), op = p.operations[0]; assert.equal(op.addedCurrencies.length, 14);
  assert.equal(op.after.pricing.CDF, 20000); assert.equal(op.after.pricing.JPY, 777);
  assert.deepEqual(op.after.pricingProvenance.CDF, { owner: 'explicit' });
});

test('identity, rights, legacy offers and invalid explicit values prevent an accidental broad migration', () => {
  for (const mutate of [
    s => s.packages[0].duration++, s => s.packages[0].categories.pop(), s => s.packages[0].googleProductId = 'OLD_SKU',
    s => s.packages[0].isActive = false, s => s.packages[2].isActive = true,
    s => s.packages[0].pricing.XAF++, s => s.packages[0].pricing.USD++, s => s.packages[1].pricing.EUR++,
    s => s.packages[0].pricing.CDF = 0, s => s.packages[0].pricing.GNF = '100',
    s => s.packages[0].pricingProvenance = [], s => s.packages[0].pricingProvenance.CDF = { orphan: true },
    s => s.databaseName = 'another_app', s => s.packages.push(clone(s.packages[0])),
  ]) { const s = state(); mutate(s); assert.throws(() => plan(s)); }
});

test('a self-rehashed plan cannot modify any existing amount, category, SKU, duration or new rate/provenance', () => {
  for (const mutate of [
    p => p.operations[0].after.pricing.XAF++, p => p.operations[0].after.pricing.USD++,
    p => p.operations[0].after.pricing.CDF++, p => p.operations[0].after.categories.pop(),
    p => p.operations[0].after.googleProductId = 'OTHER', p => p.operations[0].after.duration = 99,
    p => p.operations[0].after.pricingProvenance.CDF.referenceSha256 = '0'.repeat(64),
    p => p.reference.rates.CDF = '1', p => p.subscriptionWrites = 1, p => p.conversionAtCheckout = true,
  ]) { const p = plan(); mutate(p); resign(p); assert.throws(() => tool.verifyPlan(p, p.planHash)); }
});

test('freshness is bounded to the reference publication and a 48-hour planning window', () => {
  for (const date of ['2026-10-23T23:59:00Z', '2026-10-26T00:02:32Z', 'invalid']) assert.throws(() => tool.makePlan(state(), raw, { now: () => new Date(date) }), /RATE_REFERENCE_NOT_FRESH_AT_PLANNING/);
});

test('only new dot-path prices/provenance are eligible for writes and rollback restores absent provenance', () => {
  for (const op of plan().operations) {
    const change = tool.changes(op); assert.equal(Object.keys(change.$set).length, 30);
    assert.ok(Object.keys(change.$set).every(key => /^(pricing|pricingProvenance)\.[A-Z]{3}$/.test(key)));
    assert.equal(change.$set['pricing.XAF'], undefined); assert.equal(change.$set.categories, undefined);
  }
  const s = state(); delete s.packages[0].pricingProvenance;
  const p = plan(s); assert.equal(tool.changes(p.operations[0], true).$unset.pricingProvenance, '');
});

test('missing intent, wrong hash, expired clock or wrong database refuse before database access', async () => {
  const p = plan(), db = { databaseName: 'wintips', admin() { throw new Error('UNEXPECTED_DB_ACCESS'); } };
  await assert.rejects(tool.applyPlan({ db, plan: p, confirmedHash: p.planHash }), /PRICE_MUTATION_NOT_CONFIRMED/);
  await assert.rejects(tool.applyPlan({ db, plan: p, confirmedHash: 'bad', intent: true }), /EXACT_PRICE_PLAN_REQUIRED/);
  for (const date of ['2026-10-26T00:02:31Z', '2026-10-24T07:59:59Z', 'invalid']) await assert.rejects(tool.applyPlan({ db, plan: p, confirmedHash: p.planHash, intent: true, now: () => new Date(date) }), /WRONG_DATABASE_OR_EXPIRED_PLAN/);
});

test('CLI existing output, duplicate flags and unconfirmed mutations cannot connect or overwrite a receipt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wintips-prices-')), output = path.join(directory, 'receipt.json'); fs.writeFileSync(output, 'keep');
  try {
    await assert.rejects(tool.main(['--plan', '--rates-file', 'not-read', '--out', output]), { code: 'EEXIST' });
    await assert.rejects(tool.main(['--plan', '--rates-file', 'a', '--rates-file', 'b', '--out', output]), /DUPLICATE_ARGUMENT/);
    await assert.rejects(tool.main(['--apply', '--plan-file', 'not-read', '--out', output]), /EXPLICIT_MUTATION_CONFIRMATION_REQUIRED/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
  } finally { fs.unlinkSync(output); fs.rmdirSync(directory); }
});

test('offline CLI creates a parseable exact plan from byte zero, replacing its pending reservation without database access', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wintips-prices-offline-'));
  const stateFile = path.join(directory, 'state.json'), output = path.join(directory, 'plan.json');
  fs.writeFileSync(stateFile, JSON.stringify(state()));
  const preload = path.join(directory, 'clock.cjs');
  fs.writeFileSync(preload, "const NativeDate=Date; global.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:['2026-10-24T08:00:00Z']));} };\n");
  try {
    const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../tools/package-currency-prices.cjs'), '--plan', '--state-file', stateFile,
      '--rates-file', path.join(__dirname, 'fixtures/xaf-exchange-reference-20261024.json'), '--out', output], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, WINTIPS_PRICING_MONGO_URI: 'THIS_IS_NOT_A_VALID_URI_MUST_NEVER_BE_READ' } });
    assert.equal(result.status, 0, result.stderr); const bytes = fs.readFileSync(output); assert.equal(bytes[0], '{'.charCodeAt(0));
    const parsed = JSON.parse(bytes.toString('utf8')); tool.verifyPlan(parsed, parsed.planHash);
    assert.deepEqual(parsed, plan()); assert.equal(JSON.parse(result.stdout).databaseWrites, 0);
  } finally { for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file)); fs.rmdirSync(directory); }
});

// Execute real serializers/controllers with isolated DAL and transport mocks.
// No application bootstrap, credentials, HTTP or database connection.
function loadCommonJs(relative, mocks, extra = {}) {
  const file = path.resolve(__dirname, '..', relative), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(file), Buffer, Date, Map,
    console: { log() {}, error() {} }, require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error('UNMOCKED_REQUIRE:' + name); }, ...extra }, { filename: file });
  return module.exports;
}
function schemaMethods() {
  class Schema { constructor() { this.methods = {}; } index() {} pre() {} } Schema.Types = { Mixed: Object }; Schema.ObjectId = String;
  return loadCommonJs('src/api/models/common/Package.js', { mongoose: { Schema, model: (_, schema) => schema.methods } });
}
function controllerFor(docs) {
  const methods = schemaMethods();
  const packages = docs.map(doc => ({ ...doc, formatForLanguage(lang) { return methods.formatForLanguage.call({ toObject: () => ({ ...clone(doc), formationId: 'TEST_ONLY_NO_FORMATION' }) }, lang); } }));
  return loadCommonJs('src/api/controllers/user/packageController.js', {
    '../../models/common/Package': { find(filter) { assert.equal(filter.isActive, true); const query = { populate() { return query; }, then(resolve) { return Promise.resolve(packages).then(resolve); } }; return query; } },
    '../../services/user/subscriptionService': {}, '../../../utils/AppError': { AppError: Error, ErrorCodes: {} },
    '../../../utils/catchAsync': fn => fn, '../../services/common/packagePricing': require('../src/api/services/common/packagePricing'),
  });
}
test('real package serializer and catalogue expose both CDF plans in FR and EN with 7/14 days and 2/4 rights', async () => {
  const docs = plan().operations.map(op => op.after), controller = controllerFor(docs);
  for (const lang of ['fr', 'en']) for (const currency of tool.CURRENCIES) {
    let body; const res = { status(code) { assert.equal(code, 200); return this; }, json(data) { body = data; } };
    await controller.getAvailablePackages({ query: { lang, currency } }, res, error => { throw error; });
    assert.equal(body.data.count, 2); assert.equal(body.data.currency, currency);
    assert.deepEqual(Array.from(body.data.packages, p => p.pricing), docs.map(p => p.pricing[currency]));
    assert.deepEqual(Array.from(body.data.packages, p => p.duration), [7, 14]);
    assert.deepEqual(Array.from(body.data.packages, p => p.categories.length), [2, 4]);
    assert.equal(body.data.packages[0].name, lang === 'en' ? 'Essential' : 'Essentiel');
  }
});

test('missing or zero prices remain unavailable; adding CDF never invents a Google product', () => {
  const pkg = state().packages[0]; assert.equal(priceFor(pkg, 'CDF'), null); assert.equal(canPurchaseInCurrency(pkg, 'CDF'), false);
  pkg.pricing.CDF = 0; assert.equal(canPurchaseInCurrency(pkg, 'CDF'), false);
  pkg.pricing.CDF = 13894; pkg.availableOnGooglePlay = false;
  assert.equal(canPurchaseInCurrency(pkg, 'CDF'), true); assert.equal(canPurchaseInCurrency(pkg, 'USD'), false);
});

test('real AfribaPay request and pending transaction use each fixed CDF amount with CD provider mocks only', async () => {
  for (const op of plan().operations) {
    const posts = [], transactions = [], doc = { ...op.after, pricing: new Map(Object.entries(op.after.pricing)) };
    class Transaction { constructor(data) { Object.assign(this, data); transactions.push(this); } async save() {} async populate() {} }
    class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
    const service = loadCommonJs('src/api/services/user/AfribaPayService.js', {
      axios: { async post(url, data) { posts.push({ url, data }); return url.endsWith('/v1/token') ? { data: { data: { access_token: 'TEST_ONLY_NOT_A_REAL_TOKEN' } } } : { data: { data: { transaction_id: 'TEST_ONLY', amount: data.amount } } }; } },
      uuid: { v4: () => 'TEST_ONLY' }, crypto: require('node:crypto'), path,
      fs: { readFileSync: () => JSON.stringify({ CD: { currencies: { CDF: { operators: [{ operator_code: 'TEST_ONLY_CDF', otp_required: false }] } } } }) },
      '../../models/user/AfribaPayTransaction': Transaction, '../../models/common/Package': { findById: async () => doc },
      '../../../utils/AppError': { AppError, ErrorCodes: { VALIDATION_ERROR: 'VALIDATION_ERROR' } },
    }, { process: { env: { AFRIBAPAY_API_URL: 'https://TEST_ONLY.invalid', AFRIBAPAY_API_USER: 'TEST_ONLY', AFRIBAPAY_API_KEY: 'TEST_ONLY', AFRIBAPAY_MERCHANT_KEY: 'TEST_ONLY', APP_BASE_URL: 'https://TEST_ONLY.invalid' } } });
    const result = await service.initiatePayment('TEST_ONLY_USER', op.id, 'TEST_ONLY_PHONE', 'TEST_ONLY_CDF', 'CD', 'CDF');
    assert.equal(posts.length, 2); assert.equal(posts[1].data.amount, op.after.pricing.CDF); assert.equal(posts[1].data.currency, 'CDF'); assert.equal(posts[1].data.country, 'CD');
    assert.equal(transactions.length, 1); assert.equal(result.transaction.amount, op.after.pricing.CDF); assert.equal(result.transaction.currency, 'CDF');
    doc.pricing.delete('CDF'); const before = posts.length;
    await assert.rejects(service.initiatePayment('TEST_ONLY_USER', op.id, 'TEST_ONLY_PHONE', 'TEST_ONLY_CDF', 'CD', 'CDF'), /Prix CDF non disponible/);
    assert.equal(posts.length, before);
  }
});
