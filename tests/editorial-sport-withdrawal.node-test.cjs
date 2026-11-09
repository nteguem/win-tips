'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSportWithdrawalPlan, verifySportWithdrawalPlan, SOURCES } = require('../src/api/services/common/editorialSportWithdrawal');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { hash } = require('../src/api/services/common/editorialCataloguePlan');
const day = '2026-11-09';
const clock = () => new Date(day + 'T08:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
const category = (source, digit) => ({ _id: digit.repeat(24), editorialSource: source, isActive: true, isVip: false,
  catalogueArchived: false, name: { fr: source, en: source }, accessGate: null });
function setup() {
  const categories = [category('rdj_petit_journal', 'a'), category('rdj_turf_quinte', 'b'),
    ...SOURCES.map((source, index) => category(source, String(index + 1)))];
  const rows = categories.map((row, index) => ({ _id: String(index + 5).repeat(24), categoryId: row._id,
    source: row.editorialSource, editionDate: day, isPublished: true,
    payload: { source: row.editorialSource, editionDate: day, kind: 'match',
      title: { fr: 'Analyse', en: 'Analysis' }, startsAtUtc: day + 'T20:00:00Z', status: 'upcoming',
      sport: { key: 'tennis', name: 'Tennis' }, competition: { name: 'ATP' },
      teams: { home: { name: 'Player A' }, away: { name: 'Player B' } },
      analysis: { fr: [{ heading: 'Forme', paragraphs: ['Analyse.'] }] }, selection: { label: { fr: 'A' }, odds: 2 } } }));
  const state = { categories, rows, writes: 0 };
  const repository = { categories: async () => categories,
    category: async id => categories.find(row => row._id === id), item: async id => rows.find(row => row._id === id),
    items: async ids => rows.filter(row => ids.includes(row.categoryId)),
    availableDates: async () => [day], copies: async () => [], reviewSummaries: async () => [], openingCounts: async () => [],
    gate: async () => ({ locked: false, gated: false }), hasAnySubscription: async () => false,
    upsertBatch: async () => { state.writes++; }, recordOpening: async () => { state.writes++; } };
  return { state, service: createEditorialService({ repository, clock, importEnabled: () => true }) };
}

test('NBA and tennis disappear from FR/EN catalogues and feeds even before category migration', async () => {
  const { service } = setup();
  for (const lang of ['fr', 'en']) {
    assert.deepEqual((await service.library({ lang })).categories.map(row => row.editorialSource), ['rdj_petit_journal', 'rdj_turf_quinte']);
    assert.deepEqual((await service.feed({ lang })).categories.map(row => row.editorialSource), ['rdj_petit_journal', 'rdj_turf_quinte']);
  }
  assert.deepEqual((await service.workerConfig()).sources.map(row => row.key), ['rdj_petit_journal', 'rdj_turf_quinte']);
});

test('old dedicated-sport links fail cleanly without content reads, reviews, openings or imports', async () => {
  const { service, state } = setup();
  for (const category of state.categories.filter(row => SOURCES.includes(row.editorialSource))) {
    await assert.rejects(service.edition(category._id, day), { statusCode: 404 });
    await assert.rejects(service.content(category._id, day), { statusCode: 404 });
    await assert.rejects(service.analysis(state.rows.find(row => row.categoryId === category._id)._id), { statusCode: 404 });
    await assert.rejects(service.reviews(category._id, day), { statusCode: 404 });
    await assert.rejects(service.importBatch({ source: category.editorialSource, editionDate: day, items: [] }), { statusCode: 403 });
  }
  assert.equal(state.writes, 0);
});

test('the existing Petit Journal keeps its tennis/basket matches and protected content flow', async () => {
  const { service } = setup();
  const edition = await service.edition('a'.repeat(24), day);
  assert.equal(edition.previewItems[0].sport.key, 'tennis');
  assert.equal((await service.content('a'.repeat(24), day)).items[0].selection.odds, 2);
});

test('targeted withdrawal only archives dedicated categories, preserving every other field and reference', () => {
  const state = { databaseName: 'unit-test-only', categories: [category('rdj_petit_journal', 'a'),
    ...SOURCES.map((source, index) => ({ ...category(source, String(index + 1)), custom: { keep: true } }))],
    packages: [{ categories: ['1'.repeat(24)], pricing: { XAF: 9999 } }] };
  const before = clone(state), plan = createSportWithdrawalPlan(state);
  assert.deepEqual(state, before);
  verifySportWithdrawalPlan(plan, plan.planHash);
  assert.equal(plan.operations.length, 3);
  for (const op of plan.operations) {
    assert.equal(op.collection, 'categories');
    assert.deepEqual(op.after, { ...op.before, isActive: false, catalogueArchived: true });
  }
  const applied = { ...state, categories: state.categories.map(row => plan.operations.find(op => op.id === row._id)?.after || row) };
  assert.equal(createSportWithdrawalPlan(applied).operations.length, 0);
});

test('withdrawal rejects a rehashed plan that changes a price, source, rights or unrelated category', () => {
  const base = createSportWithdrawalPlan({ categories: [category('rdj_nba', '1')] });
  for (const change of [op => op.after.accessGate = { type: 'ad_reward' }, op => op.collection = 'packages',
    op => op.after.isVip = true, op => op.before.editorialSource = 'rdj_petit_journal']) {
    const plan = clone(base); change(plan.operations[0]); delete plan.planHash; plan.planHash = hash(plan);
    assert.throws(() => verifySportWithdrawalPlan(plan, plan.planHash), { code: 'SPORT_WITHDRAWAL_SCOPE_INVALID' });
  }
});
