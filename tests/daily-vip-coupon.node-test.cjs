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
  const imported = await service.importBatch(fixture());
  assert.equal(state.writes, 1);
  assert.equal(state.drains, 1, 'a published VIP coupon triggers the notification drain');
  assert.equal(imported.notificationsSent, 10);
});
test('optional competition geography is retained in previews and paid content without changing legacy payloads', async () => {
  const old = fixture();
  assert.deepEqual(validateBatch(old, clock()).items[0].legs[0].competition, { name: 'Competition' });
  const batch = fixture();
  batch.items[0].legs[0].competition = { name: 'Ligue 1', country: 'France', countryCode: 'FR', scope: 'national',
    logo: 'https://static.sportytrader.com/icons/foot/teams/256x256/competition.webp' };
  batch.items[0].legs[1].competition = { name: 'ATP Finals' };
  const { service, state } = setup();
  await service.importBatch(batch);
  const preview = (await service.library({ isVip: true })).categories[0].previewItems[0];
  assert.deepEqual(preview.legs[0].competition, batch.items[0].legs[0].competition);
  assert.deepEqual(preview.legs[1].competition, { name: 'ATP Finals' });
  assert.equal(preview.legs[0].selection, undefined, 'Public metadata must not expose a selection');
  state.access = true;
  const content = await service.content(a, date, { user });
  assert.deepEqual(content.items[0].legs[0].competition, batch.items[0].legs[0].competition);
  // International is the scope of the same competition, never its new name.
  const international = fixture();
  international.items[0].legs[0].competition = {
    name: 'Ligue des Nations', country: 'International', scope: 'international' };
  assert.deepEqual(validateBatch(international, clock()).items[0].legs[0].competition,
    international.items[0].legs[0].competition);
});
test('absent or unusable competition presentation does not block a verified coupon or any of its legs', async () => {
  for (const presentation of [undefined, null, {}, [], 'Unknown breadcrumb']) {
    const batch = fixture();
    for (const item of [batch.items[0], ...batch.items[0].legs]) {
      if (presentation === undefined) delete item.competition;
      else item.competition = structuredClone(presentation);
    }
    const normalized = validateBatch(batch, clock()).items[0];
    for (const item of [normalized, ...normalized.legs]) assert.deepEqual(item.competition, {});
    const { service, state } = setup();
    await service.importBatch(batch);
    assert.equal(state.writes, 1);
    assert.equal((await service.library({ isVip: true })).categories[0].itemCount, 1);
    state.access = true;
    assert.equal((await service.content(a, date, { user })).items[0].selection.totalOdds, 3.2);
  }
});

test('invalid optional competition metadata is omitted without persisting unsafe or invented fields', async () => {
  for (const extra of [{ scope: 'world' }, { country: '<script>bad</script>' }, { country: { name: 'France' } },
    { countryCode: 'fr' }, { countryCode: 'FRA' }, { logo: 'http://static.sportytrader.com/logo.png' },
    { logo: 'https://evil.invalid/logo.png' }, { logo: 'https://static.sportytrader.com@evil.invalid/logo.png' },
    { logo: 'https://127.0.0.1/logo.png' }, { venue: 'Guess' }, { $set: { country: 'Invented' } }]) {
    const batch = fixture(); Object.assign(batch.items[0].legs[0].competition, extra);
    const { service, state } = setup();
    await service.importBatch(batch);
    assert.equal(state.writes, 1);
    assert.deepEqual(state.rows[0].payload.legs[0].competition, { name: 'Competition' });
  }
  const ambiguous = fixture();
  ambiguous.items[0].legs[0].competition = { name: 'Ligue des Nations',
    scope: 'international', countryCode: 'FR', country: 'France' };
  assert.deepEqual(validateBatch(ambiguous, clock()).items[0].legs[0].competition,
    { name: 'Ligue des Nations', scope: 'international' });
  const malformedName = fixture();
  malformedName.items[0].competition = { name: '<script>bad</script>' };
  assert.deepEqual(validateBatch(malformedName, clock()).items[0].competition, {});
});

test('optional team flags and logos may be omitted while participant names remain mandatory', async () => {
  for (const extra of [{ countryCode: 'FRA' }, { countryCode: { code: 'FR' } },
    { logo: 'https://evil.invalid/logo.png' }, { logo: 'http://static.sportytrader.com/logo.png' },
    { logo: 'https://127.0.0.1/logo.png' }]) {
    const batch = fixture(); Object.assign(batch.items[0].legs[0].teams.home, extra);
    const normalized = validateBatch(batch, clock()).items[0].legs[0];
    assert.deepEqual(normalized.teams.home, { name: 'Club A' });
    assert.equal(normalized.selection.odds, 1.6);
    assert.deepEqual(normalized.provenance, batch.items[0].legs[0].provenance);
  }
  for (const name of [undefined, '', '<script>bad</script>', { name: 'Club A' }]) {
    const batch = fixture(); batch.items[0].legs[0].teams.home.name = name;
    const { service, state } = setup();
    await assert.rejects(service.importBatch(batch), { statusCode: 400 });
    assert.equal(state.writes, 0);
  }
});

test('explicit supported market families retain their sourced labels, exact odds and provenance', () => {
  for (const betType of ['match_winner', 'over_under_goals', 'btts', 'double_chance', 'draw_no_bet',
    'handicap', 'over_under_points', 'over_under_games', 'player_points', 'combined_market']) {
    const batch = fixture(), input = batch.items[0].legs[0];
    input.selection.betType = betType;
    input.selection.label = { fr: `Selection source ${betType}`, en: `Source pick ${betType}` };
    input.provenance.market = input.selection.label.fr;
    const normalized = validateBatch(batch, clock()).items[0].legs[0];
    assert.deepEqual(normalized.selection, input.selection);
    assert.deepEqual(normalized.provenance, input.provenance);
  }
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
    b => { b.items[0].legs[0].provenance.market = '<script>invented</script>'; },
    b => { b.items[0].legs[0].selection.betType = 'arbitrary_market_not_verified_by_collector'; },
    b => { b.items[0].legs[0].selection.odds = '1.60'; },
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
test('global and explicit VIP notifications target current subscribers in FR/EN without duplicate delivery or pick leaks', async () => {
  for (const source of [undefined, SOURCE]) {
    const payload = validateBatch(fixture(), clock()).items[0];
    const row = { _id: 'c'.repeat(24), payload };
    const category = { _id: a, isActive: true, isVip: true, editorialSource: SOURCE };
    const devices = [
      { user: 'subscribed', language: 'fr' },
      { user: 'subscribed', language: 'en' },
      { user: 'expired', userType: 'vip' },
      { user: 'other-category' },
      {},
      { user: 'subscribed', notificationsEnabled: false },
      { user: 'subscribed', editorialSchemaVersion: 0 },
    ].map((value, index) => ({ _id: String(index + 1).padStart(24, '0'), deviceId: 'device-' + (index + 1), editorialSchemaVersion: 1, ...value }));
    const calls = [], delivered = new Set();
    let ledger = null, claims = 0;
    const repository = {
      groups: async () => [{ source: SOURCE, editionDate: date, items: [row], category }],
      assertIndexes: async () => {}, categoryStillMatches: async () => true,
      deviceBatch: async after => after ? [] : devices,
      entitledUsers: async () => ['subscribed'],
      claim: async (_, __, ___, snapshot) => {
        if (ledger) return null;
        claims++;
        ledger = { lockToken: 'lock', status: 'processing', passes: 1, ...snapshot };
        return { ...ledger };
      },
      ledgerState: async () => ledger,
      checkpoint: async () => {},
      finish: async (_, __, fields) => { Object.assign(ledger, fields); },
      deliverySummary: async () => ({ accepted: delivered.size, retryable: 0, failed: 0, uncertain: 0 }),
    };
    const service = createEditorialNotificationService({ repository,
      push: async (appId, notification, options) => {
        calls.push({ appId, notification, options });
        options.targeting.deviceIds.forEach(deviceId => delivered.add(deviceId));
        return { fcm: options.targeting.deviceIds.length };
      }, clock, enabled: () => true, importEnabled: () => true });
    const report = await service.drain({ source, dryRun: false });
    assert.equal(report.sent, 2); assert.equal(report.groups[0].status, 'completed');
    assert.equal(claims, 1); assert.equal(calls.length, 2);
    assert.deepEqual([...delivered], ['device-1', 'device-2']);
    assert.equal(calls[0].notification.id, calls[1].notification.id);
    for (const call of calls) {
      const language = call.notification.extra.language;
      assert.equal(call.notification.title, language === 'fr'
        ? 'Ton combiné VIP du 17 novembre est prêt'
        : 'Your 17 November VIP accumulator is ready');
      assert.equal(call.notification.requiresVip, true);
      assert.equal(call.notification.businessChannel, 'vip');
      assert.equal(call.notification.extra.action, 'view_editorial');
      assert.equal(call.notification.extra.categoryId, a);
      assert.equal(call.notification.extra.itemId, row._id);
      assert.equal(call.notification.extra.editionDate, date);
      assert.equal(call.notification.extra.isVip, 'true');
      assert.equal(call.options.respectNotificationPreferences, true);
      assert.equal(call.options.respectEditorialSchemaVersion, true);
      assert.match(call.notification.body, language === 'fr' ? /2 sélections/ : /2 picks/);
      for (const secret of ['Club A gagne', 'Club A wins', '1.6', 'SportyTrader', 'provenance'])
        assert.equal(JSON.stringify(call.notification).includes(secret), false, secret);
    }
    const repeated = await service.drain({ source, dryRun: false });
    assert.equal(repeated.sent, 0); assert.equal(claims, 1); assert.equal(calls.length, 2);
  }
});
module.exports = { fixture };
