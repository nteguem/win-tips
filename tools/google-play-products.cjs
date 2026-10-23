#!/usr/bin/env node
// Prepare is read-only except Google's non-persistent regional price calculator.
// Creating DRAFT products requires an exact reviewed plan and explicit intent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PACKAGE = 'com.wintips.application';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + PACKAGE;
const OLD_SKUS = ['com.wintips.dominate_pocket_15days', 'com.wintips.reign_sweep_30days', 'com.wintips.savor_cashin_7days', 'com.wintips.taste_and_win_1day'];
const SPECS = [
  { id: 'com.wintips.essentiel_7days_v1', packageId: 'c97d577e0912523aab9f1bfb', usd: '10', days: 7,
    listings: [
      { languageCode: 'fr-FR', title: 'WinTips Essentiel — 7 jours', description: 'Accès 7 jours à Sélection Expert et au Duo du Jour. Achat ponctuel, sans renouvellement automatique.' },
      { languageCode: 'en-US', title: 'WinTips Essential — 7 days', description: '7-day access to Expert Selection and the Daily Duo. One-time purchase. No automatic renewal.' },
    ] },
  { id: 'com.wintips.premium_14days_v1', packageId: 'b8a93410f46646438cbace02', usd: '21', days: 14,
    listings: [
      { languageCode: 'fr-FR', title: 'WinTips Premium — 14 jours', description: 'Accès 14 jours aux 4 rubriques VIP : Sélection Expert, Duo du Jour, Combiné Buts et Expert Multisports. Achat ponctuel, sans renouvellement automatique.' },
      { languageCode: 'en-US', title: 'WinTips Premium — 14 days', description: '14-day access to all 4 VIP sections: Expert Selection, Daily Duo, Goals Accumulator and Multisport Expert. One-time purchase. No automatic renewal.' },
    ] },
];
function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function money(value) {
  if (!value || !/^[A-Z]{3}$/.test(value.currencyCode || '') || !/^\d+$/.test(String(value.units ?? '0')) ||
      !Number.isInteger(value.nanos ?? 0) || (value.nanos ?? 0) < 0 || (value.nanos ?? 0) >= 1e9) fail('INVALID_MONEY');
  const result = { currencyCode: value.currencyCode, units: BigInt(value.units ?? '0').toString(), nanos: value.nanos ?? 0 };
  if (result.units === '0' && result.nanos === 0) fail('NON_POSITIVE_PRICE');
  return result;
}
function normalize(product) {
  return {
    packageName: product.packageName, productId: product.productId,
    listings: (product.listings || []).map(value => ({ languageCode: value.languageCode, title: value.title, description: value.description })).sort((a, b) => a.languageCode.localeCompare(b.languageCode)),
    taxAndComplianceSettings: product.taxAndComplianceSettings || {},
    restrictedPaymentCountries: product.restrictedPaymentCountries || null,
    offerTags: (product.offerTags || []).slice().sort((a, b) => canonical(a).localeCompare(canonical(b))),
    purchaseOptions: (product.purchaseOptions || []).map(option => ({ purchaseOptionId: option.purchaseOptionId,
      buyOption: option.buyOption ? { legacyCompatible: option.buyOption.legacyCompatible === true, multiQuantityEnabled: option.buyOption.multiQuantityEnabled === true } : null,
      rentOption: option.rentOption || null, newRegionsConfig: option.newRegionsConfig || null,
      taxAndComplianceSettings: option.taxAndComplianceSettings || null,
      offerTags: (option.offerTags || []).slice().sort((a, b) => canonical(a).localeCompare(canonical(b))),
      regionalPricingAndAvailabilityConfigs: (option.regionalPricingAndAvailabilityConfigs || []).map(row => ({ regionCode: row.regionCode, availability: row.availability, price: money(row.price) })).sort((a, b) => a.regionCode.localeCompare(b.regionCode)),
    })).sort((a, b) => a.purchaseOptionId.localeCompare(b.purchaseOptionId)),
  };
}
const status = error => Number(error?.response?.status || error?.status || error?.code);
async function requestData(request, method, route, body, params) {
  const response = await request({ url: API + route, method, ...(body ? { data: body } : {}), ...(params ? { params } : {}), timeout: 20000, retry: false });
  if (response.status && (response.status < 200 || response.status >= 300)) fail('PROVIDER_HTTP_FAILURE');
  return response.data;
}
async function getProduct(request, id) {
  if (![...OLD_SKUS, ...SPECS.map(spec => spec.id)].includes(id)) fail('SKU_NOT_ALLOWLISTED');
  try { return await requestData(request, 'GET', '/oneTimeProducts/' + id); }
  catch (error) { if (status(error) === 404) return null; throw error; }
}
async function listProducts(request) {
  const products = []; let pageToken;
  for (let page = 0; page < 10; page++) {
    const data = await requestData(request, 'GET', '/oneTimeProducts', null, { pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    products.push(...(data.oneTimeProducts || []));
    if (!data.nextPageToken) return products;
    pageToken = data.nextPageToken;
  }
  fail('PRODUCT_LIST_EXCEEDS_BOUND');
}
function protection(products) {
  return OLD_SKUS.map(id => {
    const product = products.find(row => row.productId === id);
    if (!product || product.packageName !== PACKAGE) fail('PROTECTED_PRODUCT_ABSENT_OR_WRONG_APP');
    return { productId: id, sha256: hash({ product: normalize(product), states: (product.purchaseOptions || []).map(row => ({ id: row.purchaseOptionId, state: row.state })).sort((a, b) => a.id.localeCompare(b.id)) }) };
  });
}
function priceGroups(rows) {
  const groups = {};
  for (const row of rows) {
    const p = money(row.price), key = p.currencyCode;
    (groups[key] ||= []).push({ regionCode: row.regionCode, price: p });
  }
  return Object.fromEntries(Object.entries(groups).map(([currency, regions]) => [currency,
    { uniform: new Set(regions.map(row => canonical(row.price))).size === 1, regions }]));
}
async function prepareProducts({ request, now = () => new Date() }) {
  const existing = await listProducts(request), protectedProducts = protection(existing);
  const reference = existing.find(row => row.productId === 'com.wintips.savor_cashin_7days');
  const options = (reference.purchaseOptions || []).filter(row => row.state === 'ACTIVE' && row.buyOption?.legacyCompatible === true);
  if (options.length !== 1) fail('REFERENCE_OPTION_AMBIGUOUS');
  const regions = options[0].regionalPricingAndAvailabilityConfigs.filter(row => row.availability === 'AVAILABLE').map(row => row.regionCode).sort();
  if (!regions.includes('US') || !regions.includes('FR') || new Set(regions).size !== regions.length) fail('REFERENCE_REGIONS_INVALID');
  const regionSets = OLD_SKUS.map(id => ({ productId: id, regions: [...new Set((existing.find(row => row.productId === id).purchaseOptions || []).filter(row => row.state === 'ACTIVE' && row.buyOption).flatMap(row => row.regionalPricingAndAvailabilityConfigs || []).filter(row => row.availability === 'AVAILABLE').map(row => row.regionCode))].sort() }));
  const plan = { schema: 1, packageName: PACKAGE, preparedAtUtc: now().toISOString(), draftOnly: true,
    referenceProductId: reference.productId, referenceRegions: regions, oldProductRegionSets: regionSets,
    oldRegionSetsEqual: regionSets.every(row => canonical(row.regions) === canonical(regions)),
    protectedProducts, products: [], productMutations: 0, priceCalculationIsPersistentMutation: false };
  for (const spec of SPECS) {
    const converted = await requestData(request, 'POST', '/pricing:convertRegionPrices', {
      price: { currencyCode: 'USD', units: spec.usd, nanos: 0 },
      ...(reference.taxAndComplianceSettings?.productTaxCategoryCode ? { productTaxCategoryCode: reference.taxAndComplianceSettings.productTaxCategoryCode } : {}),
    });
    if (!converted.regionVersion?.version) fail('REGIONS_VERSION_ABSENT');
    const pricing = regions.map(regionCode => {
      const row = converted.convertedRegionPrices?.[regionCode];
      if (!row || row.regionCode !== regionCode) fail('MIRRORED_REGION_PRICE_ABSENT');
      return { regionCode, availability: 'AVAILABLE', price: regionCode === 'US' ? { currencyCode: 'USD', units: spec.usd, nanos: 0 } : money(row.price) };
    });
    const payload = { packageName: PACKAGE, productId: spec.id, listings: spec.listings,
      // New locations stay unavailable unless explicitly reviewed later.
      purchaseOptions: [{ purchaseOptionId: 'buy', buyOption: { legacyCompatible: true, multiQuantityEnabled: false }, regionalPricingAndAvailabilityConfigs: pricing }],
      ...(reference.taxAndComplianceSettings ? { taxAndComplianceSettings: reference.taxAndComplianceSettings } : {}) };
    const already = existing.find(row => row.productId === spec.id);
    plan.products.push({ productId: spec.id, packageId: spec.packageId, days: spec.days, baseUsd: spec.usd,
      regionsVersion: converted.regionVersion, payload, proposedState: 'DRAFT',
      existingState: already?.purchaseOptions?.map(option => option.state) || null,
      existingMatchesPrepared: already ? hash(normalize(already)) === hash(normalize(payload)) : null,
      pricingReview: priceGroups(pricing), conversion: { otherRegions: converted.convertedOtherRegionsPrice || null, sourceAmountExcludesTax: true, regionalAmountsIncludeTax: true },
      activationRequest: { requests: [{ activatePurchaseOptionRequest: { packageName: PACKAGE, productId: spec.id, purchaseOptionId: 'buy' } }] } });
  }
  plan.planHash = hash(plan); return plan;
}
function validatePlan(plan, confirmedHash) {
  const unsigned = { ...plan }; delete unsigned.planHash;
  if (!confirmedHash || plan.planHash !== confirmedHash || hash(unsigned) !== confirmedHash) fail('PLAN_HASH_MISMATCH');
  if (plan.schema !== 1 || plan.packageName !== PACKAGE || plan.draftOnly !== true || plan.products?.length !== SPECS.length) fail('PLAN_SCOPE_INVALID');
  if (canonical(plan.protectedProducts?.map(row => row.productId)) !== canonical(OLD_SKUS)) fail('PROTECTED_SKUS_CHANGED');
  for (const spec of SPECS) {
    const row = plan.products.find(value => value.productId === spec.id), payload = row?.payload;
    if (!row || row.packageId !== spec.packageId || row.days !== spec.days || row.baseUsd !== spec.usd || payload.packageName !== PACKAGE || payload.productId !== spec.id || !row.regionsVersion?.version) fail('PRODUCT_PLAN_INVALID');
    if (canonical(payload.listings) !== canonical(spec.listings) || payload.purchaseOptions?.length !== 1) fail('LISTING_OR_OPTION_INVALID');
    const option = payload.purchaseOptions[0];
    if (option.purchaseOptionId !== 'buy' || option.buyOption?.legacyCompatible !== true || option.buyOption?.multiQuantityEnabled !== false || option.rentOption || option.state || option.newRegionsConfig) fail('UNSAFE_PURCHASE_OPTION');
    const configs = option.regionalPricingAndAvailabilityConfigs || [];
    if (canonical(configs.map(value => value.regionCode).sort()) !== canonical(plan.referenceRegions)) fail('REGIONS_SCOPE_CHANGED');
    for (const config of configs) { money(config.price); if (config.availability !== 'AVAILABLE') fail('UNSAFE_REGION_AVAILABILITY'); }
    const us = configs.find(value => value.regionCode === 'US');
    if (!us || canonical(money(us.price)) !== canonical({ currencyCode: 'USD', units: spec.usd, nanos: 0 })) fail('US_PRICE_NOT_EXACT');
  }
  return plan;
}
async function createDrafts({ request, plan, confirmedHash, confirmedCreation = false }) {
  if (!confirmedCreation) fail('PRODUCT_CREATION_NOT_CONFIRMED'); validatePlan(plan, confirmedHash);
  const before = await listProducts(request);
  if (canonical(protection(before)) !== canonical(plan.protectedProducts)) fail('PROTECTED_PRODUCTS_DRIFTED');
  // Inspect every target before the first write. Any existing different target
  // fails closed; no update/repair/rename of an old or conflicting SKU is made.
  const targets = [];
  for (const row of plan.products) {
    const found = await getProduct(request, row.productId);
    if (found && hash(normalize(found)) !== hash(normalize(row.payload))) fail('EXISTING_NEW_SKU_CONFLICT');
    targets.push({ row, found });
  }
  const result = { packageName: PACKAGE, planHash: confirmedHash, created: [], alreadyExact: [], activated: 0, databaseWrites: 0 };
  for (const { row, found } of targets) {
    if (found) { result.alreadyExact.push(row.productId); continue; }
    await requestData(request, 'PATCH', '/onetimeproducts/' + row.productId, row.payload,
      { allowMissing: true, updateMask: 'listings,purchaseOptions,taxAndComplianceSettings', 'regionsVersion.version': row.regionsVersion.version });
    const verified = await getProduct(request, row.productId);
    if (!verified || hash(normalize(verified)) !== hash(normalize(row.payload)) || verified.purchaseOptions.some(option => option.state !== 'DRAFT')) fail('CREATED_DRAFT_VERIFICATION_FAILED');
    result.created.push(row.productId);
  }
  if (canonical(protection(await listProducts(request))) !== canonical(plan.protectedProducts)) fail('PROTECTED_PRODUCTS_CHANGED');
  return result;
}
async function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) { const key = argv[i]; if (!['--prepare', '--create-drafts', '--confirm-google-product-creation', '--out', '--plan-file', '--confirm-plan-hash'].includes(key)) fail('UNKNOWN_OPTION');
    if (args.has(key)) fail('DUPLICATE_OPTION'); args.set(key, ['--out', '--plan-file', '--confirm-plan-hash'].includes(key) ? argv[++i] : true); }
  if (!args.get('--out')) fail('OUTPUT_REQUIRED');
  const create = args.has('--create-drafts');
  if (create && (args.has('--prepare') || !args.has('--confirm-google-product-creation') || !args.get('--plan-file') || !args.get('--confirm-plan-hash'))) fail('EXACT_CREATION_INTENT_REQUIRED');
  if (!create && (args.has('--confirm-google-product-creation') || args.has('--plan-file') || args.has('--confirm-plan-hash'))) fail('UNEXPECTED_CREATION_OPTIONS');
  const plan = create ? validatePlan(JSON.parse(fs.readFileSync(args.get('--plan-file'), 'utf8')), args.get('--confirm-plan-hash')) : null;
  // Reserve the receipt before credentials, HTTP calls or any product write.
  const fd = fs.openSync(path.resolve(args.get('--out')), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ status: 'pending', productMutationIntent: create }) + '\n');
    const env = { ...require('dotenv').parse(fs.readFileSync(path.resolve('.env'))), ...process.env };
    if (env.GOOGLE_PLAY_PACKAGE_NAME !== PACKAGE || !env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH) fail('GOOGLE_APP_UNCONFIGURED');
    const { google } = require('googleapis'); const auth = new google.auth.GoogleAuth({ keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    const client = await auth.getClient(); const request = options => client.request(options);
    const result = create ? await createDrafts({ request, plan, confirmedHash: args.get('--confirm-plan-hash'), confirmedCreation: true }) : await prepareProducts({ request });
    fs.ftruncateSync(fd); fs.writeSync(fd, JSON.stringify(result, null, 2) + '\n', 0, 'utf8');
    process.stdout.write(JSON.stringify({ success: true, mode: create ? 'create_drafts' : 'prepare', output: path.resolve(args.get('--out')), planHash: result.planHash, created: result.created?.length || 0, activated: 0, databaseWrites: 0 }) + '\n'); return result;
  } catch (error) { fs.ftruncateSync(fd); fs.writeSync(fd, JSON.stringify({ success: false, errorCode: error.safeCode || 'PROVIDER_OR_IO_FAILURE', providerHttpStatus: Number.isInteger(status(error)) ? status(error) : null }) + '\n', 0, 'utf8'); throw error; }
  finally { fs.closeSync(fd); }
}
module.exports = { PACKAGE, OLD_SKUS, SPECS, canonical, hash, money, normalize, prepareProducts, validatePlan, createDrafts, main };
if (require.main === module) main().catch(error => { process.stdout.write(JSON.stringify({ success: false, errorCode: error.safeCode || 'PROVIDER_OR_IO_FAILURE' }) + '\n'); process.exitCode = 1; });
