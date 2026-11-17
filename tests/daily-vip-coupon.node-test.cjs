const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateBatch, hasCompleteEnglish } = require('../src/api/services/common/editorialValidation');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { publishImmutable, DAILY_INDEX } = require('../src/api/services/common/dailyVipStorage');
const { createEditorialNotificationService } = require('../src/api/services/common/editorialNotifications');
const { POLICY, SOURCE } = require('../src/api/services/common/dailyVipValidation');

const date = '2026-11-17', a = 'a'.repeat(24), user = { _id: 'b'.repeat(24) };
const clock = () => new Date(date + 'T11:00:00.000Z');
function fixture() {
  const leg = (id, sport, odds, home, away, hour) => ({ source: SOURCE, sourceId: `sp${id}`, sourceUrl: `https://www.sportytrader.com/pronostics/test-${id}/`,
    editionDate: date, kind: 'match', title: { fr: `${home} — ${away}`, en: `${home} — ${away}` }, summary: { fr: '', en: '' },
    startsAtUtc: `${date}T${hour}:00:00.000Z`, status: 'upcoming', sport: { key: sport, name: sport }, competition: { name: 'Competition' },
    teams: { home: { name: home }, away: { name: away } }, analysis: { fr: [], en: [] },
    selection: { betType: 'match_winner', label: { fr: `${home} gagne`, en: `${home} wins` }, odds },
    provenance: { predictionUrl: `https://www.sportytrader.com/pronostics/test-${id}/`, oddsUrl: `https://www.sportytrader.com/cotes/test-${id}/`,
      observedAtUtc: date + 'T10:50:00.000Z', market: `${home} gagne`, eventClockSourceUrl: `https://www.sportytrader.com/pronostics/test-${id}/` } });
  return { source: SOURCE, editionDate: date, items: [{ source: SOURCE, sourceId: `daily-vip-${date}`, sourceUrl: 'https://www.sportytrader.com/pronostics/',
    editionDate: date, kind: 'combine', title: { fr: 'Combiné du jour', en: 'Daily Accumulator' }, summary: { fr: '', en: '' },
    startsAtUtc: date + 'T19:00:00.000Z', sport: { key: 'multisport', name: 'Multisport' }, competition: { name: 'Combiné du jour' }, status: 'upcoming',
    analysis: { fr: [], en: [] }, selection: { betType: 'accumulator', label: { fr: 'Combiné', en: 'Accumulator' }, totalOdds: 3.2 },
    legs: [leg(10001, 'football', 1.6, 'Club A', 'Club B', '19'), leg(10002, 'tennis', 2, 'Player A', 'Player B', '20')],
    dailyVip: { version: 1, publisher: 'SportyTrader', bookmaker: 'Unibet', observedAtUtc: date + 'T10:50:00.000Z', policy: { ...POLICY }, result: { status: 'pending' } } }] };
}
function setup() {
  const state = { access: false, activeSubscription: true, rows: [], writes: 0, drains: 0 };
  const category = { _id: a, isActive: true, isVip: true, editorialSource: SOURCE, name: { fr: 'Combiné du jour', en: 'Daily Accumulator' } };
  const repository = { categories: async () => [category], category: async () => category, availableDates: async () => [date],
    items: async () => state.rows, copies: async () => [], reviewSummaries: async () => [], hasCategoryAccess: async () => state.access,
    hasAnySubscription: async () => state.activeSubscription, gate: async () => { throw new Error('VIP must not use rewarded gate'); },
    upsertBatch: async operations => {
      state.writes++;
      state.rows = operations.map(op => ({ _id: 'c'.repeat(24), ...op.updateOne.filter, ...op.updateOne.update.$set }));
      return { upsertedCount: 1 };
    },
  };
  const service = createEditorialService({ repository, clock, importEnabled: () => true,
    notifications: { enabled: () => true, drain: async () => { state.drains++; return { sent: 10 }; } } });
  return { service, state, category, repository };
}
test('multisport daily coupon imports bilingual selections without forcing an article or journal analysis', async () => {
  const normalized = validateBatch(fixture(), clock());
  assert.equal(normalized.items[0].selection.totalOdds, 3.2);
  assert.equal(normalized.items[0].legs[1].sport.key, 'tennis');
  assert.deepEqual(normalized.items[0].analysis, { fr: [], en: [] });
  assert.equal(hasCompleteEnglish(normalized.items[0]), true);
  const { service, state } = setup();
  await service.importBatch(fixture());
  assert.equal(state.writes, 1);
  assert.equal(state.drains, 0, 'pilot is never mass-notified during import');
});
test('wrong source/day/identity, forged URLs, duplicate legs, inconsistent product and forced odds fail before writes', async () => {
  const mutations = [
    b => { b.items[0].source = 'rdj_petit_journal'; },
    b => { b.items[0].sourceId = 'other-coupon'; },
    b => { b.items[0].legs[0].editionDate = '2026-11-16'; },
    b => { b.items[0].legs[0].sourceUrl = 'https://www.sportytrader.com.evil.invalid/pronostics/a-10001/'; },
    b => { b.items[0].legs[0].provenance.oddsUrl = 'https://www.sportytrader.com@evil.invalid/cotes/a-10001/'; },
    b => { b.items[0].legs[0].provenance.oddsUrl += '?redirect=http://127.0.0.1/'; },
    b => { b.items[0].legs[0].provenance.predictionUrl = b.items[0].legs[1].sourceUrl; },
    b => { b.items[0].legs[1] = structuredClone(b.items[0].legs[0]); },
    b => { b.items[0].selection.totalOdds = 3.49; },
    b => { b.items[0].legs[0].selection.odds = 1.9; b.items[0].selection.totalOdds = 3.8; },
    b => { b.items[0].legs[0].selection.odds = 1.75; b.items[0].legs[1].selection.odds = 1.71; b.items[0].selection.totalOdds = 2.99; },
    b => { b.items[0].legs[0].selection.odds = 1.61; b.items[0].legs[1].selection.odds = 2.18; b.items[0].selection.totalOdds = 3.51; },
    b => { b.items[0].legs[0].selection.odds = 1.75; b.items[0].legs[1].selection.odds = 2.001; b.items[0].selection.totalOdds = 3.5; },
    b => { b.items[0].legs[0].selection.odds = 1.57; b.items[0].legs[1].selection.odds = 1.91; b.items[0].selection.totalOdds = 3; },
    b => { b.items[0].legs[0].selection.odds = 1.57; b.items[0].legs[1].selection.odds = 2.23; b.items[0].selection.totalOdds = 3.5; },
    b => { b.items[0].dailyVip.policy.maxTotalOdds = 4; },
    b => { b.items[0].dailyVip.result.status = 'won'; },
    b => { b.items[0].legs[0].provenance.observedAtUtc = date + 'T12:00:00.000Z'; },
    b => { b.items[0].legs[0].provenance.observedAtUtc = date + 'T07:00:00.000Z'; },
    b => { b.items[0].legs[0].startsAtUtc = date + 'T11:10:00.000Z'; },
    b => { b.items[0].analysis.fr = [{ heading: 'Generic article', paragraphs: ['Not this format'] }]; },
    b => { b.items[0].legs[0].selection.label.en = ''; },
    b => { b.items.push(structuredClone(b.items[0])); },
  ];
  for (const mutate of mutations) {
    const batch = fixture(); mutate(batch);
    const { service, state } = setup();
    await assert.rejects(service.importBatch(batch), { statusCode: 400 });
    assert.equal(state.writes, 0);
  }
});
test('VIP catalogue exposes target odds and fixtures; picks, provenance and source links require exact category grant', async () => {
  const { service, state } = setup();
  await service.importBatch(fixture());
  for (const reader of [null, user]) {
    const library = await service.library({ isVip: true, user: reader });
    const card = library.categories[0];
    assert.equal(card.dailyVip.totalOdds, 3.2); assert.equal(card.headlineOdds, 3.2);
    assert.equal(card.locked, true); assert.equal(card.dailyVip.result.status, 'pending');
    for (const secret of ['selection', 'provenance', 'predictionUrl', 'oddsUrl', 'analysis']) assert.equal(JSON.stringify(card).includes(`"${secret}"`), false, secret);
    await assert.rejects(service.content(a, date, { user: reader }), { statusCode: reader ? 403 : 401 });
  }
  state.access = true;
  const content = await service.content(a, date, { user, lang: 'en' });
  assert.equal(content.items[0].legs[0].selection.label.en, 'Club A wins');
  assert.equal(content.items[0].legs[0].provenance.oddsUrl, fixture().items[0].legs[0].provenance.oddsUrl);
  state.access = false;
  await assert.rejects(service.content(a, date, { user }), { statusCode: 403 });
});
test('daily worker config tells the collector to stop scraping after publication', async () => {
  const { service, state, repository, category } = setup();
  assert.deepEqual((await service.workerConfig()).sources.find(source => source.key === SOURCE).dailyVipState, { state: 'new' });
  await service.importBatch(fixture());
  assert.deepEqual((await service.workerConfig()).sources.find(source => source.key === SOURCE).dailyVipState, { state: 'frozen', sourceId: `daily-vip-${date}` });
  state.rows[0].contentHash = 'a'.repeat(64);
  assert.deepEqual((await service.workerConfig()).sources.find(source => source.key === SOURCE).dailyVipState, { state: 'review_required' });
  repository.categories = async () => [category, { ...category, _id: 'd'.repeat(24) }];
  await assert.rejects(service.importBatch(fixture()), { statusCode: 409 });
});
function operation(payload) {
  return { updateOne: { filter: { categoryId: a, source: SOURCE, editionDate: date, sourceId: payload.sourceId },
    update: { $set: { kind: 'combine', payload, contentHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), isPublished: true } } } };
}
test('atomic insert-only storage is idempotent and never rewrites a published or settled payload', async () => {
  let row, writes = 0;
  const collection = { listIndexes: () => ({ toArray: async () => [DAILY_INDEX] }),
    updateOne: async (filter, update) => { writes++; assert.deepEqual(Object.keys(update), ['$setOnInsert']); if (!row) { row = update.$setOnInsert; return { upsertedCount: 1 }; } return { matchedCount: 1 }; },
    findOne: async () => row };
  const first = operation(validateBatch(fixture(), clock()).items[0]);
  assert.equal((await publishImmutable(collection, first)).upsertedCount, 1);
  assert.equal((await publishImmutable(collection, first)).matchedCount, 1);
  const snapshot = structuredClone(row), altered = structuredClone(first);
  altered.updateOne.update.$set.payload.legs[0].selection.label.fr = 'Changed after publication';
  altered.updateOne.update.$set.contentHash = 'a'.repeat(64);
  await assert.rejects(publishImmutable(collection, altered), { errorCode: 'DAILY_VIP_IMMUTABLE' });
  assert.deepEqual(row, snapshot);
  row.payload.dailyVip.result.status = 'won';
  await assert.rejects(publishImmutable(collection, first), { errorCode: 'DAILY_VIP_IMMUTABLE' });
  assert.equal(row.payload.dailyVip.result.status, 'won');
  assert.equal(writes, 4);
});
test('storage refuses incompatible or missing daily unique index before mutation', async () => {
  for (const index of [null, { ...DAILY_INDEX, sparse: true }, { ...DAILY_INDEX, expireAfterSeconds: 0 }, { ...DAILY_INDEX, unique: false }, { ...DAILY_INDEX, partialFilterExpression: { source: 'other' } }]) {
    const collection = { listIndexes: () => ({ toArray: async () => index ? [index] : [] }), updateOne: () => assert.fail('Unexpected write') };
    await assert.rejects(publishImmutable(collection, operation(fixture().items[0])), { statusCode: 503 });
  }
});
test('global and explicit notification drain skip the pilot before device, ledger and delivery operations', async () => {
  let pushes = 0;
  const service = createEditorialNotificationService({ repository: { groups: async () => [{ source: SOURCE, items: [], category: {} }],
    deviceBatch: async () => assert.fail('Pilot must not query an audience'), assertIndexes: async () => assert.fail('Pilot must not claim') },
    push: async () => { pushes++; }, clock, enabled: () => true, importEnabled: () => true });
  for (const source of [undefined, SOURCE]) {
    const report = await service.drain({ source, dryRun: false });
    assert.equal(report.sent, 0); assert.deepEqual(report.groups, []);
  }
  assert.equal(pushes, 0);
});
module.exports = { fixture };
