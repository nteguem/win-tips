const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PACKAGE, OLD_SKUS, SPECS, hash, money, prepareProducts, validatePlan, createDrafts, main } = require('../tools/google-play-products.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const usd = units => ({ currencyCode: 'USD', units: String(units), nanos: 0 });
function originals() {
  return OLD_SKUS.map(productId => ({ packageName: PACKAGE, productId,
    listings: [{ languageCode: 'en-US', title: 'Historical product', description: 'Preserved' }],
    taxAndComplianceSettings: { productTaxCategoryCode: 'TEST_TAX_CATEGORY', isTokenizedDigitalAsset: false },
    purchaseOptions: [{ purchaseOptionId: 'old-buy', state: 'ACTIVE', buyOption: { legacyCompatible: true, multiQuantityEnabled: false },
      regionalPricingAndAvailabilityConfigs: ['US', 'FR', 'BE'].map(regionCode => ({ regionCode, availability: 'AVAILABLE', price: regionCode === 'US' ? usd(5) : { currencyCode: 'EUR', units: '4', nanos: 990000000 } })) }],
  }));
}
function fakeProvider({ old = originals(), denyQuote = false, missingRegion = null } = {}) {
  const state = clone(old), calls = [];
  const request = async options => {
    calls.push(clone(options)); const route = new URL(options.url).pathname.split('/applications/' + PACKAGE)[1];
    if (options.method === 'GET' && route === '/oneTimeProducts') return { status: 200, data: { oneTimeProducts: clone(state) } };
    if (options.method === 'GET' && route.startsWith('/oneTimeProducts/')) {
      const found = state.find(row => row.productId === route.split('/').at(-1));
      if (!found) throw { response: { status: 404 } }; return { status: 200, data: clone(found) };
    }
    if (options.method === 'POST' && route === '/pricing:convertRegionPrices') {
      if (denyQuote) throw { response: { status: 403 } };
      const amount = options.data.price.units, prices = {};
      for (const regionCode of ['US', 'FR', 'BE']) if (regionCode !== missingRegion) {
        prices[regionCode] = { regionCode, price: regionCode === 'US' ? { currencyCode: 'USD', units: amount, nanos: 990000000 } :
          { currencyCode: 'EUR', units: amount === '10' ? '9' : regionCode === 'FR' ? '19' : '20', nanos: 990000000 } };
      }
      return { status: 200, data: { regionVersion: { version: 'TEST_REGIONS_2026' }, convertedRegionPrices: prices,
        convertedOtherRegionsPrice: { usdPrice: usd(amount), eurPrice: { currencyCode: 'EUR', units: '9', nanos: 0 } } } };
    }
    if (options.method === 'PATCH' && route.startsWith('/onetimeproducts/')) {
      assert.ok(SPECS.some(spec => spec.id === options.data.productId));
      assert.equal(options.params.allowMissing, true); assert.equal(options.params['regionsVersion.version'], 'TEST_REGIONS_2026');
      const product = clone(options.data); product.purchaseOptions.forEach(option => { option.state = 'DRAFT'; }); state.push(product);
      return { status: 200, data: product };
    }
    throw new Error('Unapproved mock request');
  };
  return { state, calls, request };
}
async function prepared(provider = fakeProvider()) {
  return { provider, plan: await prepareProducts({ request: provider.request, now: () => new Date('2026-10-23T21:30:00Z') }) };
}
function mutations(provider) { return provider.calls.filter(row => !['GET'].includes(row.method) && !row.url.endsWith('/pricing:convertRegionPrices')); }

test('preparation uses only metadata GET and two non-persistent price calculations, keeping US10/21 exact', async () => {
  const { plan, provider } = await prepared();
  assert.equal(mutations(provider).length, 0); assert.equal(provider.calls.filter(row => row.method === 'POST').length, 2);
  assert.equal(plan.packageName, PACKAGE); assert.equal(plan.draftOnly, true); assert.equal(plan.oldRegionSetsEqual, true);
  assert.deepEqual(plan.referenceRegions, ['BE', 'FR', 'US']);
  assert.deepEqual(plan.products.map(row => row.productId), SPECS.map(row => row.id));
  for (const row of plan.products) {
    const option = row.payload.purchaseOptions[0];
    assert.deepEqual(option.buyOption, { legacyCompatible: true, multiQuantityEnabled: false });
    assert.equal(option.state, undefined); assert.equal(option.rentOption, undefined); assert.equal(option.newRegionsConfig, undefined);
    assert.deepEqual(option.regionalPricingAndAvailabilityConfigs.find(config => config.regionCode === 'US').price, usd(row.baseUsd));
    assert.equal(row.regionsVersion.version, 'TEST_REGIONS_2026');
    assert.ok(row.payload.listings.every(listing => listing.title.length <= 55 && listing.description.length <= 200));
    assert.ok(row.payload.listings[0].description.includes('sans renouvellement automatique'));
    assert.ok(row.payload.listings[1].description.includes('No automatic renewal'));
  }
  assert.equal(plan.products[0].pricingReview.EUR.uniform, true);
  assert.equal(plan.products[1].pricingReview.EUR.uniform, false);
  assert.equal(provider.calls[1].data.productTaxCategoryCode, 'TEST_TAX_CATEGORY');
});

test('a refused conversion or missing mirrored country fails closed before any product mutation', async () => {
  for (const options of [{ denyQuote: true }, { missingRegion: 'BE' }]) {
    const provider = fakeProvider(options);
    await assert.rejects(prepareProducts({ request: provider.request })); assert.equal(mutations(provider).length, 0);
  }
});

test('exact decimals are preserved without floating point rounding and unsafe prices are refused', () => {
  assert.deepEqual(money({ currencyCode: 'USD', units: '9007199254740993', nanos: 1 }), { currencyCode: 'USD', units: '9007199254740993', nanos: 1 });
  for (const value of [usd(0), usd(-1), { currencyCode: 'USD', units: '10', nanos: 1e9 }, { currencyCode: 'USD', units: '10', nanos: 1.5 }, { currencyCode: 'usd', units: '10' }]) assert.throws(() => money(value));
});

test('creation requires the exact plan hash and explicit intent before even reading Google', async () => {
  const { plan } = await prepared(); let calls = 0; const request = async () => { calls++; throw new Error(); };
  await assert.rejects(createDrafts({ request, plan, confirmedHash: plan.planHash }), /PRODUCT_CREATION_NOT_CONFIRMED/);
  await assert.rejects(createDrafts({ request, plan, confirmedHash: 'wrong', confirmedCreation: true }), /PLAN_HASH_MISMATCH/);
  assert.equal(calls, 0);
});

test('a self-rehashed plan still cannot change package, SKU, USD amount, duration or safe BUY semantics', async () => {
  const { plan } = await prepared();
  const change = [
    p => { p.packageName = 'another.app'; }, p => { p.products[0].productId = OLD_SKUS[0]; },
    p => { p.products[0].payload.productId = OLD_SKUS[0]; }, p => { p.products[0].days = 30; },
    p => { p.products[0].payload.purchaseOptions[0].buyOption.multiQuantityEnabled = true; },
    p => { p.products[0].payload.purchaseOptions[0].state = 'ACTIVE'; },
    p => { p.products[0].payload.purchaseOptions[0].regionalPricingAndAvailabilityConfigs.find(row => row.regionCode === 'US').price = usd(9); },
  ];
  for (const modify of change) { const bad = clone(plan); modify(bad); delete bad.planHash; bad.planHash = hash(bad); assert.throws(() => validatePlan(bad, bad.planHash)); }
});

test('two drafts are created once and an exact rerun does zero writes, activation or database action', async () => {
  const { provider, plan } = await prepared(); const protectedBefore = JSON.stringify(provider.state);
  const first = await createDrafts({ request: provider.request, plan, confirmedHash: plan.planHash, confirmedCreation: true });
  assert.equal(first.created.length, 2); assert.equal(first.activated, 0); assert.equal(first.databaseWrites, 0);
  assert.equal(JSON.stringify(provider.state.slice(0, 4)), protectedBefore); assert.equal(mutations(provider).length, 2);
  const second = await createDrafts({ request: provider.request, plan, confirmedHash: plan.planHash, confirmedCreation: true });
  assert.equal(second.created.length, 0); assert.equal(second.alreadyExact.length, 2); assert.equal(mutations(provider).length, 2);
});

test('any existing conflicting target is refused before the first write, preserving both old and new products', async () => {
  const { provider, plan } = await prepared();
  const conflict = clone(plan.products[1].payload); conflict.listings[0].title = 'Another owner'; provider.state.push(conflict);
  await assert.rejects(createDrafts({ request: provider.request, plan, confirmedHash: plan.planHash, confirmedCreation: true }), /EXISTING_NEW_SKU_CONFLICT/);
  assert.equal(mutations(provider).length, 0);
});

test('a lost creation response is recovered by exact GET on replay without rewriting that product', async () => {
  const { provider, plan } = await prepared(); let loseFirstResponse = true;
  const request = async options => {
    const response = await provider.request(options);
    if (options.method === 'PATCH' && loseFirstResponse) { loseFirstResponse = false; throw Object.assign(new Error('simulated response loss'), { code: 'ETIMEDOUT' }); }
    return response;
  };
  await assert.rejects(createDrafts({ request, plan, confirmedHash: plan.planHash, confirmedCreation: true }));
  const result = await createDrafts({ request, plan, confirmedHash: plan.planHash, confirmedCreation: true });
  assert.deepEqual(result.alreadyExact, [SPECS[0].id]); assert.deepEqual(result.created, [SPECS[1].id]);
  assert.equal(mutations(provider).length, 2); assert.equal(provider.state.length, 6); assert.equal(result.activated, 0);
});

test('an old product drift aborts before creating or updating any target', async () => {
  const { provider, plan } = await prepared(); provider.state[0].listings[0].title = 'Changed independently';
  await assert.rejects(createDrafts({ request: provider.request, plan, confirmedHash: plan.planHash, confirmedCreation: true }), /PROTECTED_PRODUCTS_DRIFTED/);
  assert.equal(mutations(provider).length, 0);
});

test('CLI refuses existing receipt files before authentication and rejects any implicit activation option', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wintips-google-cli-')), out = path.join(folder, 'result.json');
  fs.writeFileSync(out, 'original');
  try {
    await assert.rejects(main(['--prepare', '--out', out]), { code: 'EEXIST' });
    await assert.rejects(main(['--activate', '--out', out]), /UNKNOWN_OPTION/);
    await assert.rejects(main(['--create-drafts', '--out', out]), /EXACT_CREATION_INTENT_REQUIRED/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'original');
  } finally { fs.unlinkSync(out); fs.rmdirSync(folder); }
});
