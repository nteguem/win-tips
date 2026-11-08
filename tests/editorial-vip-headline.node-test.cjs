const test = require('node:test');
const assert = require('node:assert/strict');
const { createEditorialService } = require('../src/api/services/common/editorialService');

const date = '2026-11-08';
const categoryId = 'a'.repeat(24);
const user = { _id: 'b'.repeat(24) };
const defaultClock = () => new Date(`${date}T09:00:00Z`);

function match(overrides = {}) {
  return {
    source: 'rdj_football_analysis', sourceId: '123', editionDate: date,
    sourceUrl: 'https://www.ruedesjoueurs.com/pronostic/test-123.html',
    kind: 'match', title: { fr: 'Equipe A contre Equipe B' },
    summary: { fr: 'PRIVATE SUMMARY' }, status: 'upcoming',
    startsAtUtc: `${date}T20:00:00.000Z`,
    sport: { key: 'football', name: 'Football' }, competition: { name: 'Ligue' },
    teams: { home: { name: 'Equipe A' }, away: { name: 'Equipe B' } },
    analysis: { fr: [{ heading: 'PRIVATE ANALYSIS', paragraphs: ['PRIVATE CONTENT'] }] },
    selection: { label: { fr: 'PRIVATE PICK' }, odds: 8.47 },
    ...overrides,
  };
}
function combined(overrides = {}) {
  return match({ kind: 'combine', source: 'rdj_football_goals',
    startsAtUtc: `${date}T19:00:00.000Z`,
    selection: { label: { fr: 'PRIVATE ACCUMULATOR' }, totalOdds: 9.235 },
    legs: [match({ startsAtUtc: `${date}T19:00:00.000Z` }), match()], ...overrides });
}
function stored(payload, overrides = {}) {
  return { _id: '1'.repeat(24), categoryId, source: payload.source,
    editionDate: payload.editionDate, isPublished: true, payload, ...overrides };
}
function setup(payloads = [match()], { clock = defaultClock, vip = true, published = true } = {}) {
  const category = { _id: categoryId, isVip: vip, isActive: true,
    editorialSource: vip ? payloads[0].source : 'rdj_petit_journal',
    name: { fr: 'Selection Expert' }, description: { fr: 'Analyses' } };
  const rows = payloads.map(payload => stored({ ...payload, source: category.editorialSource }, { isPublished: published }));
  const state = { rows, access: false, writes: 0, privateReads: 0 };
  const repo = {
    categories: async () => [category], category: async () => category,
    items: async (ids, day) => state.rows.filter(row => ids.includes(row.categoryId) && row.editionDate === day),
    availableDates: async () => [...new Set(state.rows.map(row => row.editionDate))],
    copies: async () => [], reviewSummaries: async () => [], openingCounts: async () => [],
    hasCategoryAccess: async () => state.access, hasAnySubscription: async () => state.access,
    gate: async () => ({ gated: false, locked: false }),
    recordOpening: async () => { state.writes++; throw new Error('must not record an opening'); },
    item: async () => { state.privateReads++; throw new Error('must not read a private item'); },
  };
  return { state, repo, service: createEditorialService({ repository: repo, clock }) };
}
const headline = value => ({ headlineOdds: value.headlineOdds, headlineOddsExpiresAtUtc: value.headlineOddsExpiresAtUtc });
const empty = { headlineOdds: null, headlineOddsExpiresAtUtc: null };
async function publicCard(service) {
  return (await service.library({ isVip: true })).categories[0];
}
function noProtectedContent(value) {
  const forbidden = new Set(['selection', 'selectionPreview', 'analysis', 'summary', 'odds', 'totalOdds', 'payload', 'sourceUrl']);
  function visit(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      assert.equal(forbidden.has(key), false, `protected field ${key}`);
      visit(child);
    }
  }
  visit(value);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
}

test('anonymous VIP catalogue promotes only the published numeric price and exact deadline without granting access', async () => {
  const { service, state } = setup();
  const card = await publicCard(service);
  assert.deepEqual(headline(card), { headlineOdds: 8.47, headlineOddsExpiresAtUtc: `${date}T20:00:00.000Z` });
  assert.equal(card.locked, true); assert.equal(card.requiresAuth, true);
  noProtectedContent(card);
  assert.deepEqual(headline(await service.edition(categoryId, date)), headline(card));
  await assert.rejects(service.content(categoryId, date), { statusCode: 401 });
  await assert.rejects(service.content(categoryId, date, { user }), { statusCode: 403 });
  assert.equal(state.writes, 0); assert.equal(state.privateReads, 0);
});

test('entitled VIP readers get the same public price while protected analysis remains in the existing reader', async () => {
  const { service, state } = setup();
  state.access = true;
  const card = (await service.library({ isVip: true, user })).categories[0];
  assert.equal(card.locked, false); noProtectedContent(card);
  assert.equal(card.headlineOdds, 8.47);
  const content = await service.content(categoryId, date, { user });
  assert.equal(content.items[0].selection.odds, 8.47);
  assert.equal(content.items[0].analysis.fr[0].heading, 'PRIVATE ANALYSIS');
  assert.equal(state.writes, 0);
});

test('free editions never expose a VIP promotion and a missing current edition has no stale price', async () => {
  const free = setup([match()], { vip: false });
  assert.deepEqual(headline((await free.service.library()).categories[0]), empty);
  assert.deepEqual(headline(await free.service.edition(categoryId, date)), empty);
  const absent = setup(); absent.state.rows = [];
  assert.deepEqual(headline(await publicCard(absent.service)), empty);
});

test('archived editions never promote their odds even when their kickoff was still future', async () => {
  const payload = match({ editionDate: '2026-11-07' });
  const { service } = setup([payload]);
  assert.deepEqual(headline((await service.library({ isVip: true, date: '2026-11-07' })).categories[0]), empty);
  assert.deepEqual(headline(await service.edition(categoryId, '2026-11-07')), empty);
});

test('highest eligible odds win exactly without rounding upward, and their own kickoff is the deadline', async () => {
  const { service } = setup([
    match({ selection: { odds: 8.479 } }),
    match({ selection: { odds: 9.231 }, startsAtUtc: `${date}T21:00:00.000Z` }),
    match({ selection: { odds: 10.5 }, status: 'started' }),
  ]);
  assert.deepEqual(headline(await publicCard(service)), { headlineOdds: 9.231, headlineOddsExpiresAtUtc: `${date}T21:00:00.000Z` });
});

test('a combined price is its explicit published total and expires before the first leg begins', async () => {
  const { service } = setup([combined()]);
  const card = await publicCard(service);
  assert.deepEqual(headline(card), { headlineOdds: 9.235, headlineOddsExpiresAtUtc: `${date}T19:00:00.000Z` });
  noProtectedContent(card);
  const withoutParentClock = setup([combined({ startsAtUtc: null })]);
  assert.equal((await publicCard(withoutParentClock.service)).headlineOdds, 9.235);
});

test('combined leg odds are never multiplied and a missing total cannot be replaced with a single-event price', async () => {
  for (const selection of [{ odds: 9.2 }, { totalOdds: null }, {}]) {
    const { service } = setup([combined({ selection })]);
    assert.deepEqual(headline(await publicCard(service)), empty);
  }
});

test('each leg must be upcoming, in the correct edition, and have a strictly future verified UTC clock', async () => {
  for (const change of [
    { status: 'started' }, { status: 'finished' }, { status: 'cancelled' }, { status: 'unknown' },
    { editionDate: '2026-11-07' }, { startsAtUtc: null }, { startsAtUtc: 'not a time' },
    { startsAtUtc: `${date}T08:59:59.000Z` }, { startsAtUtc: `${date}T09:00:00.000Z` },
  ]) {
    const item = combined(); Object.assign(item.legs[1], change);
    assert.deepEqual(headline(await publicCard(setup([item]).service)), empty, JSON.stringify(change));
  }
  for (const legs of [[], [match()]]) {
    assert.deepEqual(headline(await publicCard(setup([combined({ legs })]).service)), empty);
  }
});

test('a parent combined clock that differs from its earliest leg cannot advertise a later expiry', async () => {
  const item = combined({ startsAtUtc: `${date}T20:00:00.000Z` });
  assert.deepEqual(headline(await publicCard(setup([item]).service)), empty);
});

test('invalid, non-numeric, out-of-range and absent prices are never promoted', async () => {
  for (const odds of [undefined, null, 0, 1, -1, 100001, Infinity, NaN, '9.2', true, {}, []]) {
    const { service } = setup([match({ selection: { odds } })]);
    assert.deepEqual(headline(await publicCard(service)), empty, String(odds));
  }
});

test('a single event must still be upcoming and have a strictly future unambiguous valid UTC timestamp', async () => {
  for (const startsAtUtc of [null, undefined, '', 'nonsense', date, `${date}T09:00:00.000Z`,
    `${date}T08:00:00.000Z`, `${date}T25:00:00Z`, '2026-02-30T20:00:00Z', `${date}T20:00:00`, 1794168000000]) {
    assert.deepEqual(headline(await publicCard(setup([match({ startsAtUtc })]).service)), empty, String(startsAtUtc));
  }
  for (const status of ['started', 'finished', 'cancelled', 'unknown', null]) {
    assert.deepEqual(headline(await publicCard(setup([match({ status })]).service)), empty, String(status));
  }
});

test('publication must be explicit: legacy undefined state cannot promote a numeric price', async () => {
  for (const published of [false, undefined, null]) {
    const { service, state } = setup(); state.rows[0].isPublished = published;
    const card = await publicCard(service);
    assert.deepEqual(headline(card), empty);
  }
});

test('expiry removes the previous headline and reselects a later published event on the next request', async () => {
  let now = new Date(`${date}T18:59:59Z`);
  const { service } = setup([combined(), { ...combined(), startsAtUtc: `${date}T20:00:00.000Z`,
    selection: { totalOdds: 6.2 }, legs: [match(), match({ startsAtUtc: `${date}T21:00:00.000Z` })] }], { clock: () => now });
  assert.equal((await publicCard(service)).headlineOdds, 9.235);
  now = new Date(`${date}T19:00:00Z`);
  assert.deepEqual(headline(await publicCard(service)), { headlineOdds: 6.2, headlineOddsExpiresAtUtc: `${date}T20:00:00.000Z` });
  now = new Date(`${date}T20:00:00Z`);
  assert.deepEqual(headline(await publicCard(service)), empty);
});

test('one frozen Paris calendar and instant are used even when asynchronous reads cross midnight', async () => {
  let calls = 0;
  const beforeMidnight = new Date('2026-11-08T22:59:59.000Z');
  const { service, repo } = setup([match({ startsAtUtc: '2026-11-08T22:59:59.500Z' })], {
    clock: () => { calls++; return calls === 1 ? beforeMidnight : new Date('2026-11-08T23:00:01Z'); },
  });
  const originalCategories = repo.categories;
  repo.categories = async () => { beforeMidnight.setUTCDate(9); return originalCategories(); };
  const card = await publicCard(service);
  assert.equal(calls, 1);
  assert.equal(card.currentDate, date);
  assert.equal(card.headlineOdds, 8.47);
});

test('a next-night VIP fixture stops promoting at publisher midnight before the actual kickoff', async () => {
  const item = match({ source: 'rdj_multisport_analysis', startsAtUtc: '2026-11-09T04:00:00.000Z',
    sport: { key: 'basketball', name: 'Basketball' }, competition: { name: 'NBA' } });
  const { service } = setup([item]);
  assert.deepEqual(headline(await publicCard(service)), {
    headlineOdds: 8.47, headlineOddsExpiresAtUtc: '2026-11-08T23:00:00.000Z',
  });
});

test('publisher midnight expiry follows Paris daylight-saving transitions in both directions', async () => {
  for (const [day, clock, midnight, kickoff] of [
    ['2026-03-29', '2026-03-29T00:00:00Z', '2026-03-29T22:00:00.000Z', '2026-03-30T04:00:00Z'],
    ['2026-10-25', '2026-10-25T00:00:00Z', '2026-10-25T23:00:00.000Z', '2026-10-26T04:00:00Z'],
  ]) {
    const item = match({ source: 'rdj_multisport_analysis', editionDate: day, startsAtUtc: kickoff,
      sport: { key: 'basketball', name: 'Basketball' }, competition: { name: 'NBA' } });
    const { service } = setup([item], { clock: () => new Date(clock) });
    const card = await publicCard(service);
    assert.equal(card.currentDate, day);
    assert.deepEqual(headline(card), { headlineOdds: 8.47, headlineOddsExpiresAtUtc: midnight });
    assert.deepEqual(headline(await service.edition(categoryId, day)), headline(card));
  }
});
