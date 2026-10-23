const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SOURCES, validateCategoryAssignment } = require('../src/api/services/common/editorialSources');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const { createEditorialService, summary } = require('../src/api/services/common/editorialService');
const { message } = require('../src/api/services/common/editorialNotifications');
const { createPlan, verifyPlan, hash } = require('../src/api/services/common/editorialCataloguePlan');
const { priceFor, currencyCode, canPurchaseInCurrency, validateExplicitPricing } = require('../src/api/services/common/packagePricing');
const { showLegacyTicket } = require('../src/api/services/common/editorialLegacyBridge');
const { parseArgs } = require('../tools/editorial-catalogue.cjs');
const { categoryRights, snapshotForPackage } = require('../src/api/services/common/subscriptionEntitlements');
const { managedGooglePrice } = require('../src/api/services/common/packagePricing');
const config = require('../tools/editorial-catalogue.example.json');
const day = '2026-10-23', clock = () => new Date(day + 'T08:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
function match(n = 111, sport = 'football') {
  return { sourceId: String(n), sourceUrl: `https://www.ruedesjoueurs.com/pronostic/team-a-team-b-${n}.html`, kind: 'match',
    title: { fr: `Equipe ${n} contre adversaire`, en: `Team ${n} versus opponent` }, summary: { fr: 'Analyse', en: 'Analysis' },
    startsAtUtc: day + 'T19:00:00Z', status: 'upcoming', sport: { key: sport, name: sport }, competition: { name: sport === 'basketball' ? 'NBA' : 'Ligue' },
    teams: { home: { name: `Equipe ${n}` }, away: { name: `Adversaire ${n}` } },
    analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Analyse originale.'] }], en: [{ heading: 'Context', paragraphs: ['Original analysis.'] }] },
    selection: { label: { fr: 'Victoire domicile', en: 'Home win' }, odds: null, betType: 'match_winner' } };
}
function ticket(source = 'rdj_football_duo', count = 2) {
  const row = { ...match(), sourceId: '74768', sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/sport-news/news-pmu-sport/74768-combine-23-10-2026.html',
    kind: 'combine', legs: Array.from({ length: count }, (_, index) => match(111 + index)),
    selection: { label: { fr: 'Ticket RDJ', en: 'RDJ ticket' }, odds: null, totalOdds: 2, betType: 'accumulator' } };
  delete row.teams;
  row.curation = { kind: 'publisher_ticket', publisher: 'RDJ', bookmaker: 'PMU PLAY Sport', sourceUrl: row.sourceUrl };
  if (source === 'rdj_football_goals') for (const leg of row.legs) leg.selection.betType = 'btts';
  return row;
}
const batch = (source, row) => ({ source, editionDate: day, items: [row] });
function night(n = 111) {
  const row = match(n, 'basketball'); row.startsAtUtc = '2026-10-24T02:30:00Z';
  row.editionConvention = 'nba_following_night';
  row.scheduleProof = { sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261023', sourceId: '401810123', method: 'provider_schedule', provider: 'espn',
    matchedParticipants: [row.teams.home.name, row.teams.away.name], startsAtUtc: row.startsAtUtc, status: 'upcoming' };
  return row;
}

test('six selectable sources have fixed free/VIP roles; the legacy source is editable only in place', () => {
  assert.equal(SOURCES.filter(row => row.selectable).length, 6);
  assert.equal(SOURCES.filter(row => row.selectable && row.access === 'vip').length, 4);
  assert.equal(SOURCES.find(row => row.key === 'rdj_petit_journal').label, 'Le Petit Journal');
  assert.throws(() => validateCategoryAssignment('rdj_football_combine', true));
  assert.equal(validateCategoryAssignment('rdj_football_combine', true, 'rdj_football_combine'), 'rdj_football_combine');
  for (const key of ['rdj_football_duo', 'rdj_football_goals', 'rdj_multisport_analysis']) assert.throws(() => validateCategoryAssignment(key, false));
});
test('managed prices use an explicit validated SKU/currency and purchased category snapshots never fall back to edited rights', () => {
  const pkg = { catalogueKey: 'wintips-rdj-catalogue-v1:package:essential', availableOnGooglePlay: true, googleProductType: 'ONE_TIME_PRODUCT', googleProductId: 'TEST_SKU', pricing: { EUR: 5.34, USD: 6 }, categories: ['a', 'b'] };
  assert.deepEqual(managedGooglePrice(pkg, 'TEST_SKU', 'EUR'), { amount: 5.34, currency: 'EUR', source: 'configured_catalogue_reference' });
  assert.throws(() => managedGooglePrice(pkg, 'OTHER', 'EUR'));
  assert.throws(() => managedGooglePrice(pkg, 'TEST_SKU', 'XAF'));
  assert.throws(() => managedGooglePrice(pkg, 'TEST_SKU', null));
  const snapshot = snapshotForPackage(pkg); pkg.categories = ['a', 'c', 'd'];
  assert.deepEqual(categoryRights(snapshot, pkg), ['a', 'b']);
  assert.deepEqual(categoryRights({ categorySnapshot: [] }, pkg), []);
  assert.deepEqual(categoryRights({}, pkg), ['a', 'c', 'd']);
});
test('an existing receipt output is rejected before database loading or mutation', async () => {
  const os = require('node:os'), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wintips-receipt-test-'));
  const output = path.join(folder, 'existing.json'); fs.writeFileSync(output, 'original');
  try {
    await assert.rejects(require('../tools/editorial-catalogue.cjs').main(['--out', output]), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(output, 'utf8'), 'original');
  } finally { fs.unlinkSync(output); fs.rmdirSync(folder); }
});
test('a managed receipt cannot be replayed through a legacy target or another user', async () => {
  const foreign = { user: 'owner', package: 'managed', productId: 'MANAGED_SKU', subscription: 'receipt' };
  let providerCalls = 0, subscriptionReads = 0;
  const mocks = {
    googleapis: { google: { auth: { GoogleAuth: class {} }, androidpublisher: () => ({ purchases: { products: { get: async () => { providerCalls++; return { data: { purchaseState: 0 } }; } } } }) } },
    '../../models/user/GooglePlayTransaction': { findOne: async () => foreign },
    '../../models/common/Subscription': { findById: () => { subscriptionReads++; throw new Error('must not read another entitlement'); } },
    '../../models/common/Package': { findById: async () => ({ googleProductId: 'LEGACY_SKU' }) },
    '../common/packagePricing': require('../src/api/services/common/packagePricing'),
    '../common/managedGoogleActivation': require('../src/api/services/common/managedGoogleActivation'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/services/user/GooglePlayService.js'), 'utf8'), {
    module, require: key => { if (!(key in mocks)) throw new Error(key); return mocks[key]; }, process: { env: {} }, console: { log() {}, error() {}, warn() {} },
  });
  await assert.rejects(module.exports.validateOneTimePurchase('TEST_TOKEN', 'LEGACY_SKU', 'owner', 'legacy', 'EUR'), /autre activation/);
  await assert.rejects(module.exports.validateOneTimePurchase('TEST_TOKEN', 'LEGACY_SKU', 'other', 'legacy', 'EUR'), /autre activation/);
  await assert.rejects(module.exports.validateOneTimePurchase('TEST_TOKEN', 'WRONG_SKU', 'owner', 'legacy', 'EUR'), /incompatible/);
  assert.equal(providerCalls, 2); assert.equal(subscriptionReads, 0);
});
test('Duo requires exactly two distinct matches, publisher provenance and an explicit total from 2 through 4', () => {
  for (const value of [2, 4]) { const row = ticket(); row.selection.totalOdds = value; assert.equal(validateBatch(batch('rdj_football_duo', row), clock()).items[0].selection.totalOdds, value); }
  const invalid = [ticket('rdj_football_duo', 3), ticket('rdj_football_duo', 1)];
  for (const value of [null, 1.99, 4.01]) { const row = ticket(); row.selection.totalOdds = value; invalid.push(row); }
  const missing = ticket(); delete missing.curation; invalid.push(missing);
  const fabricated = ticket(); fabricated.curation.kind = 'wintips_curation'; invalid.push(fabricated);
  const wrongUrl = ticket(); wrongUrl.curation.sourceUrl = wrongUrl.sourceUrl.replace('74768', '74769'); invalid.push(wrongUrl);
  const same = ticket(); same.legs[1].teams = clone(same.legs[0].teams); invalid.push(same);
  const sameId = ticket(); sameId.legs[1] = clone(sameId.legs[0]); invalid.push(sameId);
  for (const row of invalid) assert.throws(() => validateBatch(batch('rdj_football_duo', row), clock()));
});
test('Goals accepts two/three goals-only selections and rejects winners or a fourth event', () => {
  for (const count of [2, 3]) {
    const row = ticket('rdj_football_goals', count);
    row.legs.forEach((leg, index) => { leg.selection.betType = ['btts', 'over_under_goals', 'team_goals'][index]; });
    assert.equal(validateBatch(batch('rdj_football_goals', row), clock()).items[0].legs.length, count);
  }
  const row = ticket('rdj_football_goals'); row.legs[1].selection.betType = 'match_winner';
  assert.throws(() => validateBatch(batch('rdj_football_goals', row), clock()));
  assert.throws(() => validateBatch(batch('rdj_football_goals', ticket('rdj_football_goals', 4)), clock()));
});
test('all new sources retain exact edition, publisher identity, 30 minute lead and English-before-write guards', async () => {
  const row = ticket(), source = 'rdj_football_duo';
  row.legs[1].startsAtUtc = day + 'T08:29:59Z'; assert.throws(() => validateBatch(batch(source, row), clock()));
  row.legs[1].startsAtUtc = day + 'T08:30:00Z'; row.startsAtUtc = null; assert.equal(validateBatch(batch(source, row), clock()).items.length, 1);
  const stale = ticket(); stale.sourceUrl = stale.sourceUrl.replace('23-10', '22-10'); stale.curation.sourceUrl = stale.sourceUrl; assert.throws(() => validateBatch(batch(source, stale), clock()));
  const wrongId = ticket(); wrongId.legs[0].sourceId = '999'; assert.throws(() => validateBatch(batch(source, wrongId), clock()));
  let writes = 0;
  const repository = { categories: async () => [{ _id: 'a'.repeat(24), isActive: true, isVip: true, editorialSource: source }], upsertBatch: async () => { writes++; return {}; } };
  const service = createEditorialService({ repository, clock, importEnabled: () => true });
  const untranslated = ticket(); delete untranslated.legs[0].analysis.en;
  await assert.rejects(service.importBatch(batch(source, untranslated))); assert.equal(writes, 0);
  await service.importBatch(batch(source, ticket())); assert.equal(writes, 1);
});
test('Multisports supports only basketball and volleyball single analyses', () => {
  for (const sport of ['basketball', 'volleyball']) assert.equal(validateBatch(batch('rdj_multisport_analysis', match(111, sport)), clock()).items[0].sport.key, sport);
  assert.throws(() => validateBatch(batch('rdj_multisport_analysis', match()), clock()));
  assert.throws(() => validateBatch(batch('rdj_football_analysis', match(111, 'basketball')), clock()));
  assert.throws(() => validateBatch(batch('rdj_multisport_analysis', ticket()), clock()));
});
test('NBA following-night is a proven exception, not a general future-day relaxation', () => {
  const accepted = validateBatch(batch('rdj_multisport_analysis', night()), clock()).items[0];
  assert.equal(accepted.editionDate, day); assert.equal(accepted.startsAtUtc, '2026-10-24T02:30:00.000Z');
  for (const change of [row => { row.sport.key = 'football'; }, row => { row.competition.name = 'WNBA'; }, row => { row.competition.name = 'Euroleague'; },
    row => { row.startsAtUtc = '2026-10-25T02:30:00Z'; }, row => { row.startsAtUtc = '2026-10-24T10:00:00Z'; },
    row => { delete row.scheduleProof; }, row => { delete row.editionConvention; }, row => { row.scheduleProof.startsAtUtc = '2026-10-24T03:00:00Z'; },
    row => { row.scheduleProof.sourceUrl = 'https://attacker.example/nba'; }, row => { row.scheduleProof.matchedParticipants.reverse(); },
    row => { row.scheduleProof.status = 'finished'; }, row => { row.sourceUrl = 'https://www.ruedesjoueurs.com/pronostic/nba-25-10-2026-111.html'; }]) {
    const row = night(); change(row); assert.throws(() => validateBatch(batch('rdj_multisport_analysis', row), clock()));
  }
  const beforeNoon = night(); beforeNoon.startsAtUtc = '2026-10-24T09:59:59Z'; beforeNoon.scheduleProof.startsAtUtc = beforeNoon.startsAtUtc;
  assert.equal(validateBatch(batch('rdj_multisport_analysis', beforeNoon), clock()).items.length, 1);
  const petit = night(); petit.sourceUrl = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/111-journal-du-23-octobre-2026.html';
  assert.equal(validateBatch(batch('rdj_petit_journal', petit), clock()).items.length, 1);
  petit.sourceUrl = petit.sourceUrl.replace('23-octobre', '24-octobre'); assert.throws(() => validateBatch(batch('rdj_petit_journal', petit), clock()));
});
test('new FR/EN notification labels keep stable deep links and locked summaries disclose no selection', () => {
  for (const source of ['rdj_football_duo', 'rdj_football_goals', 'rdj_multisport_analysis']) {
    const payload = source === 'rdj_multisport_analysis' ? match(111, 'basketball') : ticket(source);
    const group = { source, editionDate: day, category: { _id: 'a'.repeat(24), isVip: true }, items: [{ _id: 'b'.repeat(24), payload }] };
    const fr = message('wintips', group, 'fr'), en = message('wintips', group, 'en');
    assert.equal(fr.id, en.id); assert.equal(fr.extra.action, 'view_editorial'); assert.equal(fr.extra.categoryId, 'a'.repeat(24));
    assert.notEqual(fr.title, en.title); assert.equal(fr.body.includes('Ticket RDJ'), false);
    const teaser = summary({ _id: 'b'.repeat(24), source, sourceId: payload.sourceId, editionDate: day, payload }, true, 'fr');
    for (const key of ['selection', 'analysis', 'curation', 'scheduleProof', 'payload']) assert.equal(key in teaser, false);
  }
});
test('catalogue planning is dry-run, deterministic, six categories/two packs, and never invents a SKU', () => {
  const state = { databaseName: 'wintips_test', categories: [], packages: [], subscriptionCounts: {} }, before = clone(state);
  const plan = createPlan(state, config, day + 'T08:00:00Z'); assert.deepEqual(state, before);
  assert.equal(plan.operations.length, 8); assert.equal(plan.targetCounts.categories, 6); assert.equal(plan.targetCounts.packages, 2);
  assert.equal(plan.operations.filter(op => op.collection === 'categories' && op.after.isVip === false).every(op => op.after.accessGate === null), true);
  assert.equal(plan.operations.filter(op => op.collection === 'packages').every(op => op.after.availableOnGooglePlay === false && op.after.googleProductId === null), true);
  verifyPlan(plan, plan.planHash); assert.throws(() => verifyPlan(plan, 'wrong'));
  const tampered = clone(plan); tampered.operations[0].after.isVip = true; assert.throws(() => verifyPlan(tampered, plan.planHash));
  const appliedState = { ...state, categories: plan.operations.filter(op => op.collection === 'categories').map(op => op.after), packages: plan.operations.filter(op => op.collection === 'packages').map(op => op.after) };
  assert.equal(createPlan(appliedState, config).operations.length, 0);
});
test('explicit adoption keeps legacy IDs/mappings; retired offers and archived storefronts preserve purchased rights', () => {
  const oldCat = { _id: { $oid: 'a'.repeat(24) }, name: { fr: 'Pass Découverte', en: 'Old' }, isVip: false, isActive: true, editorialSource: null,
    externalSources: [{ system: 'bigwin', appId: 'bigwin', categoryId: 'original' }] };
  const oldVip = { _id: { $oid: 'c'.repeat(24) }, name: { fr: 'Ancien VIP' }, isVip: true, isActive: true, editorialSource: null };
  const oldPack = { _id: { $oid: 'b'.repeat(24) }, isActive: true, duration: 90, pricing: { XAF: 12345 }, categories: [oldCat._id, oldVip._id] };
  const reviewed = { ...clone(config), adoptCategoryIds: { rdj_petit_journal: 'a'.repeat(24) }, retirePackageIds: ['b'.repeat(24)], archiveCategoryIds: ['c'.repeat(24)] };
  const plan = createPlan({ categories: [oldCat, oldVip], packages: [oldPack], subscriptionCounts: { ['b'.repeat(24)]: 10 } }, reviewed);
  assert.equal(plan.targetCategoryIds.rdj_petit_journal, 'a'.repeat(24));
  assert.deepEqual(plan.operations.find(op => op.id === 'a'.repeat(24)).after.externalSources, oldCat.externalSources);
  assert.deepEqual(plan.operations.find(op => op.id === 'b'.repeat(24)).after, { ...oldPack, isActive: false });
  const archived = plan.operations.find(op => op.id === 'c'.repeat(24)).after;
  assert.equal(archived.isActive, true); assert.equal(archived.catalogueArchived, true);
  const req = { headers: { 'x-wintips-editorial': '1' } };
  assert.equal(showLegacyTicket(archived, req), false); assert.equal(showLegacyTicket(archived, req, { detail: true }), true); assert.equal(showLegacyTicket(archived, req, { history: true }), true);
});
test('ambiguous or owned source mappings and purchased managed package rewrites fail rather than silently migrate rights', () => {
  const active = { _id: { $oid: 'a'.repeat(24) }, isVip: false, isActive: true, editorialSource: 'rdj_petit_journal' };
  assert.throws(() => createPlan({ categories: [active], packages: [] }, config), { code: 'CATEGORY_MAPPING_REQUIRED' });
  const plan = createPlan({ categories: [], packages: [] }, config);
  const state = { categories: plan.operations.filter(op => op.collection === 'categories').map(op => op.after), packages: plan.operations.filter(op => op.collection === 'packages').map(op => op.after) };
  const changed = clone(config); changed.packages[0].pricing.EUR = 5.35;
  state.subscriptionCounts = { [state.packages[0]._id.$oid]: 1 };
  assert.throws(() => createPlan(state, changed), { code: 'PURCHASED_PACKAGE_IMMUTABLE' });
});
test('catalogue CLI defaults to read-only and requires exact reviewed intent for writes', () => {
  assert.equal(parseArgs([]).mode, 'plan'); assert.throws(() => parseArgs(['--apply']), { code: 'INTENT_REQUIRED' });
  assert.throws(() => parseArgs(['--plan', '--rollback']), { code: 'ARGUMENTS' });
  assert.equal(parseArgs(['--apply', '--plan-file', 'reviewed.json', '--confirm-sha256', 'abc', '--confirm-catalogue-mutation']).intent, true);
});
test('explicit currency pricing never falls back to XAF/zero or activates unconfigured Google products', () => {
  const pkg = { paymentMode: 'money', pricing: { XAF: 3500, EUR: 5.34, USD: 6 }, availableOnGooglePlay: false };
  assert.equal(priceFor(pkg, 'GMD'), null); assert.equal(priceFor({ pricing: { XAF: 0 } }, 'XAF'), null);
  assert.equal(currencyCode('eur'), 'EUR'); assert.throws(() => currencyCode({ $ne: null }));
  assert.equal(canPurchaseInCurrency(pkg, 'XAF'), true); assert.equal(canPurchaseInCurrency(pkg, 'EUR'), false); assert.equal(canPurchaseInCurrency(pkg, 'USD'), false);
  const mockSku = { ...pkg, availableOnGooglePlay: true, googleProductId: 'TEST_ONLY_NOT_A_CONSOLE_PRODUCT' };
  assert.equal(canPurchaseInCurrency(mockSku, 'EUR'), true); assert.equal(priceFor(mockSku, 'EUR'), 5.34); assert.equal(priceFor(mockSku, 'USD'), 6);
  assert.deepEqual(validateExplicitPricing({ EUR: 5.34 }), { EUR: 5.34 }); assert.throws(() => validateExplicitPricing({ EUR: 0 }));
  for (const currency of ['XAF', 'XOF', 'GNF']) { assert.throws(() => validateExplicitPricing({ [currency]: 3500.5 })); assert.equal(priceFor({ pricing: { [currency]: 3500.5 } }, currency), null); }
  for (const currency of ['EUR', 'USD']) { assert.throws(() => validateExplicitPricing({ [currency]: 5.345 })); assert.equal(validateExplicitPricing({ [currency]: 5.34 })[currency], 5.34); }
});

function response() { return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function controllers(rows) {
  const chain = data => ({ populate() { return this; }, then(ok, bad) { return Promise.resolve(data).then(ok, bad); } });
  const docs = rows.map(row => ({ ...row, getPricing(currency) { return this.pricing?.[currency]; }, toJSON() { return clone(row); },
    formatForLanguage(lang) { return { ...clone(row), name: row.name[lang], description: row.description?.[lang] || '' }; } }));
  const Package = { find: () => chain(docs), findOne: () => chain(docs[0] || null), findById: () => chain(docs[0] || null) };
  const common = { '../../models/common/Package': Package, '../../services/user/subscriptionService': { getActiveSubscriptions: async () => [] },
    '../../models/common/Formation': {}, '../../models/common/Category': {},
    '../../../utils/AppError': { AppError: class extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }, ErrorCodes: { VALIDATION_ERROR: 'VALIDATION_ERROR', NOT_FOUND: 'NOT_FOUND' } },
    '../../../utils/catchAsync': fn => fn, '../../services/common/packagePricing': require('../src/api/services/common/packagePricing') };
  function load(file) {
    const exports = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/controllers', file), 'utf8'), {
      exports, console: { log() {} }, require(key) { if (!(key in common)) throw new Error(key); return common[key]; },
    }); return exports;
  }
  return { admin: load('admin/packageController.js'), user: load('user/packageController.js') };
}
test('admin raw list/detail preserves all languages, fractional prices and offers without a currency filter', async () => {
  const raw = { _id: 'a'.repeat(24), name: { fr: 'Essentiel', en: 'Essential' }, description: { fr: 'FR', en: 'EN' }, paymentMode: 'money', pricing: { EUR: 5.34, USD: 6 }, isActive: true };
  const { admin } = controllers([raw]); let res = response();
  await admin.getAllPackages({ query: { raw: 'true', currency: 'XAF' } }, res, error => { throw error; });
  assert.equal(res.body.data.count, 1); assert.deepEqual(JSON.parse(JSON.stringify(res.body.data.packages[0])), raw);
  res = response(); await admin.getPackage({ query: { raw: 'true', lang: 'en' }, params: { id: raw._id } }, res, error => { throw error; });
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.data.package)), raw);
});
test('the user catalogue/detail share exact currency and configured-rail rules, with no false free price', async () => {
  const base = { _id: 'a'.repeat(24), name: { fr: 'Essentiel', en: 'Essential' }, paymentMode: 'money', pricing: { XAF: 3500, EUR: 5.34, USD: 6 }, availableOnGooglePlay: false, isActive: true };
  const { user } = controllers([base]); let res = response();
  await user.getAvailablePackages({ query: { currency: 'xaf' } }, res, error => { throw error; });
  assert.equal(res.body.data.currency, 'XAF'); assert.equal(res.body.data.packages[0].pricing, 3500); assert.equal(res.body.data.packages[0].currency, 'XAF');
  for (const currency of ['EUR', 'USD', 'GMD']) {
    res = response(); await user.getAvailablePackages({ query: { currency } }, res, error => { throw error; }); assert.equal(res.body.data.count, 0);
    let failure; await user.getPackage({ query: { currency }, params: { id: base._id } }, response(), error => { failure = error; }); assert.equal(failure.statusCode, 404);
  }
  const testOnly = controllers([{ ...base, availableOnGooglePlay: true, googleProductId: 'TEST_ONLY_NOT_REAL' }]).user;
  for (const [currency, amount] of [['EUR', 5.34], ['USD', 6]]) {
    res = response(); await testOnly.getAvailablePackages({ query: { currency } }, res, error => { throw error; }); assert.equal(res.body.data.packages[0].pricing, amount);
    res = response(); await testOnly.getPackage({ query: { currency }, params: { id: base._id } }, res, error => { throw error; }); assert.equal(res.body.data.package.pricing[currency], amount);
  }
});
test('archiving catalogue fields is subject to the same protected admin route detection', () => {
  const { containsEditorialField } = require('../src/api/services/common/editorialSources');
  assert.equal(containsEditorialField({ catalogueArchived: true }), true);
  assert.equal(containsEditorialField({ $set: { catalogueKey: 'forged' } }), true);
  assert.equal(containsEditorialField({ name: 'Normal legacy edit' }), false);
});
