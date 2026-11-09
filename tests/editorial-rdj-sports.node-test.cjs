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
test('dedicated sport sources are disabled for WinTips but historical payloads stay identifiable', () => {
  for (const key of ['rdj_nba', 'rdj_tennis', 'basketusa_nba']) {
    const source = SOURCES.find(row => row.key === key);
    assert.equal(source.selectable, false); assert.equal(source.importEnabled, false); assert.equal(source.appEnabled, false);
    assert.throws(() => validateCategoryAssignment(key, false));
    assert.equal(validateCategoryAssignment(key, false, key), key);
    assert.throws(() => validateBatch({ source: key, editionDate: day, items: [] }, now()), /lecture uniquement/);
  }
});
test('NBA same-day/night and tennis survive full normalize/read cycles with FR/EN and original odds', () => {
  for (const input of [item(), item('nba', true), item('tennis')]) {
    const value = normalizeItem(input, input.source, day);
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
    const value = item('nba', true); mutate(value); assert.throws(() => normalizeItem(value, value.source, day));
  }
  const tennis = item('tennis'); tennis.sport.key = 'football'; assert.throws(() => normalizeItem(tennis, tennis.source, day));
  assert.throws(() => validateBatch(batch(item()), now()), { statusCode: 403 });
});
test('old sport activation tools cannot create or reapply a saved activation plan', () => {
  const { createNbaCategoryPlan, verifyNbaCategoryPlan } = require('../src/api/services/common/editorialNbaCategory');
  for (const run of [() => createRdjSportsCategoryPlan({}), () => verifyRdjSportsCategoryPlan({}, ''),
    () => createNbaCategoryPlan({}), () => verifyNbaCategoryPlan({}, '')]) {
    assert.throws(run, { code: 'SPORT_SOURCES_DISABLED_FOR_WINTIPS' });
  }
});
