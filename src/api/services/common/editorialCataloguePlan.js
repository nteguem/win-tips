const crypto = require('node:crypto');
const { SOURCES } = require('./editorialSources');
const { validateExplicitPricing } = require('./packagePricing');

const VERSION = 'wintips-rdj-catalogue-v1';
const TARGETS = SOURCES.filter(source => source.selectable !== false).map(source => source.key);
const VIP = TARGETS.filter(key => SOURCES.find(source => source.key === key).access === 'vip');
const plain = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const stableId = key => crypto.createHash('sha256').update(`${VERSION}|${key}`).digest('hex').slice(0, 24);
const oid = value => ({ $oid: value });
const idOf = value => typeof value === 'string' ? value : value && value.$oid;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function id(value) { if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) fail('INVALID_MAPPING', 'Category/package ObjectId expected'); return value.toLowerCase(); }
function validateConfig(config) {
  if (!config || config.version !== VERSION || config.appId !== 'wintips') fail('CONFIG', 'WinTips catalogue version required');
  if (!Array.isArray(config.categories) || config.categories.length !== 6 || new Set(config.categories.map(row => row.source)).size !== 6 || config.categories.some(row => !TARGETS.includes(row.source))) fail('CONFIG', 'Exactly six target categories required');
  for (const row of config.categories) {
    if (!row.name?.fr || !row.name?.en || !row.description?.fr || !row.description?.en) fail('CONFIG', 'Bilingual category name and description required');
  }
  if (!Array.isArray(config.packages) || config.packages.length !== 2 || new Set(config.packages.map(row => row.key)).size !== 2) fail('CONFIG', 'Exactly two packages required');
  for (const row of config.packages) {
    try { validateExplicitPricing(row.pricing); } catch (_) { fail('CONFIG', 'Currency precision or explicit pricing invalid'); }
    const essential = row.key === 'essentiel_7d', premium = row.key === 'premium_14d';
    if (!essential && !premium) fail('CONFIG', 'Unknown package key');
    const expected = essential ? ['rdj_football_analysis', 'rdj_football_duo'] : VIP;
    if (row.duration !== (essential ? 7 : 14) || !Array.isArray(row.sources) || JSON.stringify([...row.sources].sort()) !== JSON.stringify([...expected].sort())) fail('CONFIG', 'Package duration or category membership invalid');
    if (!row.name?.fr || !row.name?.en || row.pricing?.XAF !== (essential ? 3500 : 7000) || row.pricing?.XOF !== (essential ? 3500 : 7000)) fail('CONFIG', 'Approved XAF/XOF prices and bilingual name required');
    for (const [currency, amount] of Object.entries(row.pricing)) {
      if (!/^[A-Z]{3}$/.test(currency) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) fail('CONFIG', 'Explicit positive currency prices, at most two decimals, required');
    }
  }
  const mappings = config.adoptCategoryIds || {};
  if (Object.keys(mappings).some(key => !TARGETS.includes(key)) || new Set(Object.values(mappings).map(id)).size !== Object.keys(mappings).length) fail('INVALID_MAPPING', 'Unique category mappings required');
  if (config.retirePackageIds && (!Array.isArray(config.retirePackageIds) || config.retirePackageIds.some(value => !id(value)))) fail('INVALID_MAPPING', 'Package retire IDs invalid');
  if (config.archiveCategoryIds && (!Array.isArray(config.archiveCategoryIds) || config.archiveCategoryIds.some(value => !id(value)))) fail('INVALID_MAPPING', 'Category archive IDs invalid');
}

// State contains Extended JSON documents, not user/device/transaction records.
// Existing ObjectIds and dates remain lossless in the reviewed plan/receipt.
function createPlan(state, config, now = new Date().toISOString()) {
  validateConfig(config);
  const operations = [], categories = {}, warnings = [];
  const currentCategories = state.categories || [], currentPackages = state.packages || [];
  function operation(collection, docId, before, after, reason) {
    if (before && hash(before) === hash(after)) return;
    if (collection === 'categories') after.updatedAt = { $date: now };
    if (!before) after.createdAt = { $date: now };
    operations.push({ collection, id: docId, before: before ? plain(before) : null, after: plain(after), reason });
  }
  for (const spec of config.categories) {
    const key = `${VERSION}:category:${spec.source}`;
    const managed = currentCategories.filter(row => row.catalogueKey === key);
    if (managed.length > 1) fail('DUPLICATE_CATALOGUE', 'Duplicate managed category');
    const adopted = config.adoptCategoryIds?.[spec.source];
    const existing = adopted ? currentCategories.find(row => idOf(row._id) === id(adopted)) : managed[0];
    if (adopted && !existing) fail('MAPPING_NOT_FOUND', 'Category mapping not found');
    const source = SOURCES.find(row => row.key === spec.source), isVip = source.access === 'vip';
    if (existing && (existing.isVip !== isVip || (existing.catalogueKey && existing.catalogueKey !== key))) fail('MAPPING_CONFLICT', 'Category access/ownership cannot be overwritten');
    const docId = existing ? idOf(existing._id) : stableId(`category:${spec.source}`);
    if (!existing && currentCategories.some(row => idOf(row._id) === docId)) fail('ID_CONFLICT', 'Stable category ID already owned');
    const after = { ...(existing || {}), _id: oid(docId), catalogueKey: key, name: spec.name,
      description: spec.description, icon: spec.icon || '📰', isVip, isActive: true,
      editorialSource: spec.source, accessGate: null, catalogueArchived: false };
    // No invented historical success percentage. External source associations
    // and all other existing fields remain byte-for-byte in adopted documents.
    if (!existing) { after.successRate = null; after.externalSources = []; }
    categories[spec.source] = docId;
    operation('categories', docId, existing, after, existing ? 'adopt_or_update_category' : 'create_category');
    const unmapped = currentCategories.filter(row => idOf(row._id) !== docId && row.editorialSource === spec.source && row.isActive === true);
    if (unmapped.length) fail('CATEGORY_MAPPING_REQUIRED', 'An existing active source category must be explicitly adopted, not duplicated');
  }
  for (const spec of config.packages) {
    const key = `${VERSION}:package:${spec.key}`;
    const managed = currentPackages.filter(row => row.catalogueKey === key);
    if (managed.length > 1) fail('DUPLICATE_CATALOGUE', 'Duplicate managed package');
    const existing = managed[0], docId = existing ? idOf(existing._id) : stableId(`package:${spec.key}`);
    if (!existing && currentPackages.some(row => idOf(row._id) === docId)) fail('ID_CONFLICT', 'Stable package ID already owned');
    const after = { ...(existing || {}), _id: oid(docId), catalogueKey: key, name: spec.name,
      description: spec.description || { fr: '', en: '' }, pricing: spec.pricing,
      pricingProvenance: spec.pricingProvenance || {}, duration: spec.duration,
      categories: spec.sources.map(source => oid(categories[source])), paymentMode: 'money', adsRequired: null,
      isActive: true };
    if (!existing) { after.availableOnGooglePlay = false; after.googleProductId = null; after.googleProductType = null; }
    if (existing && hash(existing) !== hash(after) && (state.subscriptionCounts?.[docId] || 0) > 0) fail('PURCHASED_PACKAGE_IMMUTABLE', 'A purchased package must not be rewritten; create a new reviewed version');
    operation('packages', docId, existing, after, existing ? 'update_managed_package' : 'create_package');
  }
  for (const retiredId of config.retirePackageIds || []) {
    const docId = id(retiredId), existing = currentPackages.find(row => idOf(row._id) === docId);
    if (!existing) fail('MAPPING_NOT_FOUND', 'Package to retire not found');
    if (existing.catalogueKey?.startsWith(VERSION + ':')) fail('CONFIG', 'Cannot retire a target package in the same plan');
    operation('packages', docId, existing, { ...existing, isActive: false }, 'stop_legacy_sales_preserve_rights');
  }
  for (const archivedId of config.archiveCategoryIds || []) {
    const docId = id(archivedId), existing = currentCategories.find(row => idOf(row._id) === docId);
    if (!existing) fail('MAPPING_NOT_FOUND', 'Category to archive not found');
    if (Object.values(categories).includes(docId)) fail('CONFIG', 'Cannot archive a target category');
    operation('categories', docId, existing, { ...existing, catalogueArchived: true }, 'archive_storefront_preserve_rights');
  }
  const retired = new Set(config.retirePackageIds || []);
  const legacyPackages = currentPackages.filter(row => row.isActive === true && !row.catalogueKey?.startsWith(VERSION + ':') && !retired.has(idOf(row._id)));
  const archived = new Set(config.archiveCategoryIds || []);
  const legacyCategories = currentCategories.filter(row => row.isActive === true && row.catalogueArchived !== true && !archived.has(idOf(row._id)) && !Object.values(categories).includes(idOf(row._id)));
  if (legacyPackages.length) warnings.push({ code: 'LEGACY_OFFERS_REMAIN', packageIds: legacyPackages.map(row => idOf(row._id)), reason: 'No legacy offer is retired without explicit IDs; existing rights are never reassigned' });
  if (legacyCategories.length) warnings.push({ code: 'LEGACY_CATEGORIES_PRESERVED', categoryIds: legacyCategories.map(row => idOf(row._id)), reason: 'Old categories/tickets/mappings remain intact; review explicit adoption before activation' });
  const plan = { version: VERSION, appId: 'wintips', databaseName: state.databaseName || 'wintips', readOnly: true, targetCategoryIds: categories,
    targetCounts: { categories: 6, packages: 2 }, configHash: hash(config), operations, warnings,
    entitledUsersModified: false, notificationsSent: false, legacyRightsPreserved: true };
  return { ...plan, planHash: hash(plan) };
}

function verifyPlan(plan, confirmHash) {
  const { planHash, ...body } = plan || {};
  if (plan?.version !== VERSION || plan.appId !== 'wintips' || hash(body) !== planHash || confirmHash !== planHash) fail('PLAN_CONFIRMATION_REQUIRED', 'Exact reviewed plan SHA-256 required');
  if (!Array.isArray(plan.operations) || plan.operations.some(op => !['categories', 'packages'].includes(op.collection))) fail('PLAN_INVALID', 'Only category/package operations allowed');
}
module.exports = { VERSION, TARGETS, VIP, hash, stableId, createPlan, verifyPlan, validateConfig, idOf };
