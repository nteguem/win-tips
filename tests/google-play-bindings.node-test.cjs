const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hash } = require('../tools/google-play-products.cjs');
const { EXPECTED, CATEGORIES, euroMoney, summaryProduct, googleProof, makePlan, verifyPlan, applyPlan, main } = require('../tools/google-play-bindings.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const eurPrices = ['9.99', '20.99'];
const money = (currencyCode, units, nanos = 0) => ({ currencyCode, units: String(units), nanos });
function product(spec, euro, changed = {}) {
  return { packageName: 'com.wintips.application', productId: spec.id, listings: clone(spec.listings),
    purchaseOptions: [{ purchaseOptionId: 'buy', state: 'ACTIVE', buyOption: { legacyCompatible: true, multiQuantityEnabled: false },
      regionalPricingAndAvailabilityConfigs: [
        { regionCode: 'US', availability: 'AVAILABLE', price: money('USD', spec.usd) },
        { regionCode: 'FR', availability: 'AVAILABLE', price: euroMoney(euro) },
        { regionCode: 'BE', availability: 'AVAILABLE', price: money('EUR', '99', 990000000) },
        { regionCode: 'TD', availability: 'AVAILABLE', price: money('USD', '88', 990000000) },
      ] }], ...changed };
}
function state() {
  return { databaseName: 'wintips_bindings_test',
    categories: CATEGORIES.map(row => ({ _id: row.id, name: clone(row.name), editorialSource: row.source, isVip: true, isActive: true })),
    packages: EXPECTED.map(spec => ({ _id: spec.packageId, catalogueKey: 'wintips-rdj-catalogue-v1:package:' + spec.key,
      name: { fr: spec.key }, categories: [...spec.categories], duration: spec.days, isActive: true, paymentMode: 'money',
      availableOnGooglePlay: false, googleProductId: null, googleProductType: null,
      pricing: { XAF: spec.cfa, XOF: spec.cfa, USD: spec.oldUsd, EUR: spec.oldEur, CDF: 12345 },
      pricingProvenance: { XAF: { kind: 'owner_explicit' }, XOF: { kind: 'owner_explicit' }, approval: 'existing' },
    })).concat({ _id: 'a'.repeat(24), name: { fr: 'Untouched legacy offer' }, pricing: { USD: 42 }, isActive: false }) };
}
function requestFor(products = EXPECTED.map((spec, i) => product(spec, eurPrices[i]))) {
  const calls = [];
  const request = async config => {
    calls.push(config); assert.equal(config.method, 'GET');
    const found = products.find(row => config.url.endsWith('/' + row.productId));
    if (!found) throw { response: { status: 404 } };
    return { status: 200, data: clone(found) };
  };
  return { request, calls, products };
}
async function prepared() {
  const provider = requestFor(), proof = await googleProof({ request: provider.request, eurPrices, now: () => new Date('2026-10-23T22:00:00Z') });
  return { provider, proof, plan: makePlan(state(), proof, eurPrices) };
}

test('a plan binds only the two exact IDs, uses US/FR references and preserves every other field/currency', async () => {
  const { plan } = await prepared(); verifyPlan(plan, plan.planHash);
  assert.equal(plan.operations.length, 2); assert.equal(plan.protectedOtherPackages.length, 1); assert.equal(plan.categoryProof.length, 4);
  for (const [i, op] of plan.operations.entries()) {
    assert.equal(op.id, EXPECTED[i].packageId); assert.equal(op.after.googleProductId, EXPECTED[i].id);
    assert.equal(op.after.googleProductType, 'ONE_TIME_PRODUCT'); assert.equal(op.after.availableOnGooglePlay, true);
    assert.equal(op.after.pricing.USD, Number(EXPECTED[i].usd)); assert.equal(op.after.pricing.EUR, Number(eurPrices[i]));
    for (const field of ['duration', 'categories', 'name', 'isActive', 'paymentMode', 'catalogueKey']) assert.deepEqual(op.after[field], op.before[field]);
    for (const currency of ['XAF', 'XOF', 'CDF']) assert.equal(op.after.pricing[currency], op.before.pricing[currency]);
    assert.deepEqual(op.after.pricingProvenance.XAF, op.before.pricingProvenance.XAF);
    assert.equal(op.after.pricingProvenance.googlePlayBinding.actualChargeVerified, false);
    assert.equal(op.after.pricingProvenance.googlePlayBinding.regionalPricesMayDiffer, true);
  }
});

test('actual regional USD/EUR variations are reported without being rejected or overwritten', async () => {
  const { proof } = await prepared();
  for (const row of proof.products) {
    assert.equal(row.regionalCurrencyReview.USD.uniform, false); assert.equal(row.regionalCurrencyReview.EUR.uniform, false);
    assert.equal(row.regionalCurrencyReview.EUR.regions.find(value => value.regionCode === 'BE').price.units, '99');
    assert.equal(row.regionalCurrencyReview.USD.regions.find(value => value.regionCode === 'TD').price.units, '88');
  }
});

test('wrong app/SKU, inactive or unsafe BUY, invalid regional price or wrong US/FR reference fails closed', () => {
  const spec = EXPECTED[0]; const changes = [
    p => { p.packageName = 'another.app'; }, p => { p.productId = 'old.sku'; },
    p => { p.purchaseOptions[0].state = 'DRAFT'; }, p => { p.purchaseOptions[0].buyOption.legacyCompatible = false; },
    p => { p.purchaseOptions[0].buyOption.multiQuantityEnabled = true; }, p => { p.purchaseOptions[0].rentOption = {}; },
    p => { p.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0].price = money('USD', 9); },
    p => { p.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[1].price = euroMoney('1.11'); },
    p => { p.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[2].price = money('EUR', 0); },
    p => { p.listings[0].title = 'WinTips Essentiel 30 jours'; },
    p => { p.listings[1].description = 'Automatic renewal'; },
  ];
  for (const change of changes) { const p = product(spec, eurPrices[0]); change(p); assert.throws(() => summaryProduct(p, spec, eurPrices[0])); }
});

test('planning refuses changed CFA, duration, rights, four category names or prior Google/price state', async () => {
  const { proof } = await prepared(); const changes = [
    s => { s.packages[0].pricing.XAF++; }, s => { s.packages[0].pricing.XOF++; },
    s => { s.packages[1].categories.pop(); }, s => { s.packages[0].duration = 30; },
    s => { s.categories[0].name.fr = 'Another name'; }, s => { s.categories[1].name.en = 'Wrong name'; },
    s => { s.categories[2].editorialSource = 'wrong_source'; }, s => { s.packages[1].availableOnGooglePlay = true; },
    s => { s.packages[0].pricing.USD = 99; },
  ];
  for (const change of changes) { const s = state(); change(s); assert.throws(() => makePlan(s, proof, eurPrices)); }
});

test('self-rehashing a plan cannot add a field/category/currency change outside the reviewed binding', async () => {
  const { plan } = await prepared();
  for (const change of [p => { p.operations[0].after.categories.push('f'.repeat(24)); }, p => { p.operations[0].after.pricing.XAF++; }, p => { p.operations[0].after.googleProductId = 'OLD_SKU'; }]) {
    const bad = clone(plan); change(bad); delete bad.planHash; bad.planHash = hash(bad); assert.throws(() => verifyPlan(bad, bad.planHash));
  }
});

test('without exact intent/hash apply performs no database or Google operation', async () => {
  const { plan } = await prepared(); let calls = 0; const request = async () => { calls++; throw new Error(); };
  await assert.rejects(applyPlan({ request, plan, confirmedHash: plan.planHash }), /BINDING_MUTATION_NOT_CONFIRMED/);
  await assert.rejects(applyPlan({ request, plan, confirmedHash: 'wrong', intent: true }), /EXACT_BINDING_PLAN_REQUIRED/);
  assert.equal(calls, 0);
});

test('CLI reserves no existing receipt and requires explicit EUR and mutation intent before connecting', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wintips-binding-cli-')), out = path.join(folder, 'result.json'); fs.writeFileSync(out, 'original');
  try {
    await assert.rejects(main(['--plan', '--essential-eur', eurPrices[0], '--premium-eur', eurPrices[1], '--out', out]), { code: 'EEXIST' });
    await assert.rejects(main(['--plan', '--out', out]), /EXPLICIT_EUR_PRICE_REQUIRED/);
    await assert.rejects(main(['--apply', '--out', out]), /EXPLICIT_BINDING_INTENT_REQUIRED/);
    await assert.rejects(main(['--plan', '--plan', '--out', out]), /DUPLICATE_ARGUMENT/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'original');
  } finally { fs.unlinkSync(out); fs.rmdirSync(folder); }
});

module.exports = { state, product, requestFor, eurPrices };
