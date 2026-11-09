'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch, normalizeItem } = require('../src/api/services/common/editorialValidation');
const { SOURCES, validateCategoryAssignment } = require('../src/api/services/common/editorialSources');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createRdjSportsCategoryPlan, verifyRdjSportsCategoryPlan } = require('../src/api/services/common/editorialRdjSportsCategories');
const day = '2026-11-09', now = () => new Date(day + 'T08:00:00Z');
const clone = x => JSON.parse(JSON.stringify(x));
function item(sport = 'nba', night = false) {
  const value = { source: 'rdj_' + sport, sourceId: '123', editionDate: day, kind: 'match',
    sourceUrl: 'https://www.ruedesjoueurs.com/pronostic/player-a-player-b-123.html',
    title: { fr: 'A contre B', en: 'A versus B' }, summary: { fr: 'Analyse source', en: 'Source analysis' },
    startsAtUtc: night ? '2026-11-10T02:00:00Z' : day + 'T15:00:00Z',
    sport: { key: sport === 'nba' ? 'basketball' : 'tennis', name: sport }, competition: { name: sport === 'nba' ? 'NBA' : 'ATP Stockholm' },
    teams: { home: { name: 'Player A' }, away: { name: 'Player B' } },
    analysis: { fr: [{ heading: 'Forme', paragraphs: ['Analyse originale.'] }], en: [{ heading: 'Form', paragraphs: ['Original analysis.'] }] },
    selection: { label: { fr: 'Victoire Player A', en: 'Player A to win' }, odds: 1.58 }, status: 'upcoming' };
  if (night) {
    value.editionConvention = 'rdj_sport_following_night';
    value.scheduleProof = { sourceUrl: value.sourceUrl, sourceId: value.sourceId,
      indexUrl: 'https://www.ruedesjoueurs.com/pronostics/nba-943387.html', method: 'rdj_sport_detail_clock_v1', provider: 'rdj',
      editionDate: day, matchedParticipants: ['Player A', 'Player B'], startsAtUtc: value.startsAtUtc, status: 'upcoming' };
  }
  return value;
}
const batch = row => ({ source: row.source, editionDate: day, items: [row] });
test('active NBA and tennis are free RDJ sources; BasketUSA is read-only', () => {
  for (const key of ['rdj_nba', 'rdj_tennis']) {
    assert.equal(validateCategoryAssignment(key, false), key);
    assert.throws(() => validateCategoryAssignment(key, true));
  }
  const legacy = SOURCES.find(row => row.key === 'basketusa_nba');
  assert.equal(legacy.selectable, false); assert.equal(legacy.importEnabled, false);
  assert.throws(() => validateBatch({ source: legacy.key, editionDate: day, items: [] }, now()), /lecture uniquement/);
});
test('NBA same-day/night and tennis survive full normalize/read cycles with FR/EN and original odds', () => {
  for (const input of [item(), item('nba', true), item('tennis')]) {
    const value = validateBatch(batch(input), now()).items[0];
    assert.deepEqual(normalizeItem(value, input.source, day), value);
    assert.equal(value.selection.odds, 1.58); assert.equal(value.analysis.en[0].paragraphs[0], 'Original analysis.');
  }
});
test('RDJ night proof cannot relax identity, source, tournament, clock, date or the tennis window', () => {
  for (const mutate of [v => v.scheduleProof.sourceId = '999', v => v.scheduleProof.sourceUrl += '?x=1',
    v => v.scheduleProof.indexUrl = SOURCES.find(s => s.key === 'rdj_tennis').url,
    v => v.scheduleProof.editionDate = '2026-11-08', v => v.scheduleProof.matchedParticipants.reverse(),
    v => v.scheduleProof.startsAtUtc = '2026-11-10T03:00:00Z', v => v.competition.name = 'WNBA',
    v => v.sourceUrl = v.sourceUrl.replace('-123.', '-999.'), v => { v.source = 'rdj_tennis'; v.sport.key = 'tennis'; },
    v => { v.startsAtUtc = '2026-11-10T13:00:00Z'; v.scheduleProof.startsAtUtc = v.startsAtUtc; }]) {
    const value = item('nba', true); mutate(value); assert.throws(() => validateBatch(batch(value), now()));
  }
  const tennis = item('tennis'); tennis.sport.key = 'football'; assert.throws(() => validateBatch(batch(tennis), now()));
  const late = item(); late.startsAtUtc = day + 'T08:29:59Z'; assert.throws(() => validateBatch(batch(late), now()));
});
test('category migration preserves NBA identity and BO data; re-planning is idempotent', () => {
  const old = { _id: { $oid: 'a'.repeat(24) }, editorialSource: 'basketusa_nba', isVip: false, isActive: true,
    name: { fr: 'Mon NBA', en: 'My NBA' }, externalSources: ['custom'], accessGate: { adsRequired: 2 }, catalogueKey: 'custom-key' };
  const state = { databaseName: 'test-only', categories: [old], packages: [{ pricing: { XAF: 9999 } }] }, before = clone(state);
  const plan = createRdjSportsCategoryPlan(state, day + 'T08:00:00Z');
  assert.deepEqual(state, before); verifyRdjSportsCategoryPlan(plan, plan.planHash);
  const nba = plan.operations.find(op => op.after.editorialSource === 'rdj_nba');
  assert.equal(nba.id, 'a'.repeat(24)); assert.deepEqual(nba.after, { ...old, editorialSource: 'rdj_nba' });
  assert.equal(plan.operations.length, 2); assert.equal(plan.operations.some(op => op.collection === 'packages'), false);
  const applied = { ...state, categories: plan.operations.map(op => op.after) };
  assert.equal(createRdjSportsCategoryPlan(applied).operations.length, 0);
  assert.throws(() => createRdjSportsCategoryPlan({ categories: [old, { ...old, _id: { $oid: 'b'.repeat(24) } }] }));
});
test('migrated NBA preserves library, edition, content and old-app analysis links', async () => {
  const category = { _id: 'a'.repeat(24), isActive: true, isVip: false, editorialSource: 'rdj_nba', name: { fr: 'NBA', en: 'NBA' } };
  const payload = item(); payload.source = 'basketusa_nba'; payload.sourceId = 'basketusa_' + 'b'.repeat(32);
  const row = { _id: 'c'.repeat(24), categoryId: category._id, editionDate: day, source: payload.source, payload, isPublished: true };
  let mappings;
  const repository = { categories: async () => [category], category: async () => category, items: async () => [row], item: async () => row,
    availableDates: async (_ids, _day, _limit, values) => { mappings = values; return [day]; },
    gate: async () => ({ gated: false, locked: false }), hasAnySubscription: async () => false,
    copies: async () => [], reviewSummaries: async () => [], openingCounts: async () => [] };
  const service = createEditorialService({ repository, clock: now });
  assert.equal((await service.library()).categories[0].itemCount, 1);
  assert.deepEqual(mappings.map(row => row.source), ['rdj_nba', 'basketusa_nba']);
  assert.equal((await service.edition(category._id, day)).itemCount, 1);
  assert.equal((await service.content(category._id, day)).items[0].source, 'basketusa_nba');
  assert.equal((await service.analysis(row._id)).source, 'basketusa_nba');
});
test('an already published legacy NBA edition is neither imported nor notified again after cutover', async () => {
  let writes = 0, sends = 0;
  const repository = { categories: async () => [{ _id: 'a'.repeat(24), editorialSource: 'rdj_nba', isActive: true, isVip: false }],
    legacyNbaPublished: async () => true, upsertBatch: async () => { writes++; } };
  const service = createEditorialService({ repository, clock: now, importEnabled: () => true,
    notifications: { enabled: () => true, drain: async () => { sends++; } } });
  const result = await service.importBatch(batch(item()));
  assert.equal(result.reason, 'published_legacy_nba_edition_preserved');
  assert.equal(writes, 0); assert.equal(sends, 0);
  assert.deepEqual((await service.workerConfig()).sources, []);
});
