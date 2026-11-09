'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch, normalizeItem } = require('../src/api/services/common/editorialValidation');
const { validatePublisherUrl, validateCategoryAssignment } = require('../src/api/services/common/editorialSources');
const { createPlan } = require('../src/api/services/common/editorialCataloguePlan');
const { message } = require('../src/api/services/common/editorialNotifications');
const { summary } = require('../src/api/services/common/editorialService');
const source = 'basketusa_nba', day = '2026-11-08';
const clock = new Date(day + 'T12:00:00Z');
const url = 'https://www.basketusa.com/paris-sportifs/pronostics-nba/#pari-kings-spurs';
const clone = value => JSON.parse(JSON.stringify(value));
function item() {
  const row = { source, sourceId: 'basketusa_' + 'a'.repeat(32), sourceUrl: url, editionDate: day,
    sourcePublication: { publishedAt: day + 'T09:00:00Z' }, kind: 'match',
    title: { fr: 'Sacramento Kings — San Antonio Spurs', en: 'Sacramento Kings — San Antonio Spurs' },
    summary: { fr: 'Kings et Spurs se retrouvent cette nuit.', en: 'Kings meet Spurs tonight.' },
    startsAtUtc: '2026-11-09T02:00:00Z', sport: { key: 'basketball', name: 'Basketball' }, competition: { name: 'NBA' },
    teams: { home: { name: 'Sacramento Kings' }, away: { name: 'San Antonio Spurs' } },
    analysis: { fr: [{ heading: 'La rencontre', paragraphs: ['Une analyse NBA vérifiée.'] }], en: [{ heading: 'The matchup', paragraphs: ['A verified NBA analysis.'] }] },
    selection: { label: { fr: 'Victoire Sacramento Kings', en: 'Sacramento Kings to win' }, odds: 1.85 }, status: 'upcoming',
    editionConvention: 'basketusa_following_night' };
  row.scheduleProof = { sourceUrl: url, sourceId: row.sourceId, method: 'basketusa_article_clock', provider: 'basketusa',
    editionDate: day, articlePublishedAt: row.sourcePublication.publishedAt,
    matchedParticipants: [row.teams.home.name, row.teams.away.name], startsAtUtc: row.startsAtUtc, status: 'upcoming' };
  return row;
}
const batch = row => ({ source, editionDate: day, items: [row] });

test('NBA has its own free source and only the reviewed article anchors are accepted', () => {
  assert.throws(() => validateCategoryAssignment(source, false));
  assert.equal(validateCategoryAssignment(source, false, source), source);
  assert.throws(() => validateCategoryAssignment(source, true));
  assert.equal(validatePublisherUrl(url, source), url);
  for (const bad of [url.replace('www.basketusa.com', 'evil.example'), url.replace('#pari-', '#other-'),
    url.replace('/pronostics-nba/', '/other/'), url.replace('#', '?redirect=x#')]) assert.throws(() => validatePublisherUrl(bad, source));
  assert.throws(() => validatePublisherUrl(url, 'rdj_petit_journal'));
});
test('explicit article-day and overnight NBA proof survive normalize/read cycles', () => {
  const normalized = normalizeItem(item(), source, day);
  assert.equal(normalized.editionConvention, 'basketusa_following_night');
  assert.equal(normalized.startsAtUtc, '2026-11-09T02:00:00.000Z');
  assert.deepEqual(normalizeItem(normalized, source, day), normalized);
});
test('a stale mutable article cannot be imported as today, even with a valid upcoming match', () => {
  for (const published of ['2026-11-06T09:00:00Z', '2026-11-08T09:00:00']) {
    const row = item(); row.sourcePublication.publishedAt = published; row.scheduleProof.articlePublishedAt = published;
    assert.throws(() => normalizeItem(row, source, day), published);
  }
});
test('proofs for different participants, sources, dates or clocks remain rejected', () => {
  for (const [key, value] of Object.entries({ sourceId: 'basketusa_wrong', editionDate: '2026-11-07', provider: 'rdj',
    matchedParticipants: ['Other team', 'San Antonio Spurs'], startsAtUtc: '2026-11-09T03:00:00Z' })) {
    const row = item(); row.scheduleProof[key] = value;
    assert.throws(() => normalizeItem(row, source, day), key);
  }
  for (const [key, value] of [['sport', { key: 'football', name: 'Football' }], ['competition', { name: 'EuroLeague' }]]) {
    const row = item(); row[key] = value; assert.throws(() => normalizeItem(row, source, day), key);
  }
  const late = item(); late.startsAtUtc = '2026-11-09T13:00:00Z'; late.scheduleProof.startsAtUtc = late.startsAtUtc;
  assert.throws(() => normalizeItem(late, source, day));
});
test('the NBA batch and match labels remain distinct without leaking analysis through previews', () => {
  const payload = normalizeItem(item(), source, day);
  const row = { _id: 'a'.repeat(24), source, editionDate: day, sourceId: payload.sourceId, kind: 'match', payload };
  const view = summary(row, true, 'fr');
  assert.equal(view.source, source);
  assert.equal(view.sport.key, 'basketball');
  assert.equal(view.competition.name, 'NBA');
  assert.equal(view.analysis, undefined); assert.equal(view.selection, undefined);
  const notification = message('wintips', { category: { _id: 'b'.repeat(24), isVip: false }, source, editionDate: day, items: [row] }, 'fr');
  assert.match(notification.title, /NBA/); assert.doesNotMatch(notification.title, /Petit Journal|Quinté/);
});
test('NBA extends the catalogue while existing VIP prices and category rights stay intact', () => {
  const legacy = clone(require('../tools/editorial-catalogue.example.json'));
  const extended = clone(require('../tools/editorial-catalogue.nba.example.json'));
  const oldPlan = createPlan({}, legacy), newPlan = createPlan({}, extended);
  assert.equal(oldPlan.targetCounts.categories, 6); assert.equal(newPlan.targetCounts.categories, 7);
  assert.equal(newPlan.operations.filter(row => row.collection === 'categories' && row.after.editorialSource === 'rdj_nba').length, 1);
  for (const op of oldPlan.operations.filter(row => row.collection === 'packages')) {
    assert.deepEqual(newPlan.operations.find(row => row.id === op.id).after.categories, op.after.categories);
    assert.deepEqual(newPlan.operations.find(row => row.id === op.id).after.pricing, op.after.pricing);
  }
  const missing = clone(extended); missing.categories = missing.categories.filter(row => row.source !== 'rdj_turf_quinte');
  assert.throws(() => createPlan({}, missing));
});
test('targeted activation never rewrites existing categories, prices, packages or rights', () => {
  const { createNbaCategoryPlan, verifyNbaCategoryPlan, ID } = require('../src/api/services/common/editorialNbaCategory');
  const state = { databaseName: 'test-only', categories: [{ _id: { $oid: 'f'.repeat(24) }, name: { fr: 'Custom' }, isVip: true }],
    packages: [{ _id: { $oid: 'e'.repeat(24) }, pricing: { XAF: 9999 }, categories: ['f'.repeat(24)] }] };
  const original = clone(state), plan = createNbaCategoryPlan(state, '2026-11-08T12:00:00Z');
  assert.deepEqual(state, original); assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].id, ID); assert.equal(plan.operations[0].before, null);
  assert.equal(plan.operations[0].collection, 'categories'); assert.equal(plan.operations[0].after.icon, '🏀');
  verifyNbaCategoryPlan(plan, plan.planHash);
  assert.throws(() => verifyNbaCategoryPlan(plan, 'bad-hash'));
  state.categories.push(clone(plan.operations[0].after));
  assert.equal(createNbaCategoryPlan(state).operations.length, 0);
  state.categories[state.categories.length - 1].isVip = true;
  assert.throws(() => createNbaCategoryPlan(state));
});
