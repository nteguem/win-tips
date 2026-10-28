const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
const { fallback, factsFromBatch, digest } = require('../src/api/services/common/editorialCopy');
const { pagination, reviewInput, openingInput } = require('../src/api/services/common/editorialLibrary');

const date = '2026-10-25', a = 'a'.repeat(24), b = 'b'.repeat(24), c = 'c'.repeat(24);
const user = { _id: 'd'.repeat(24), pseudo: 'Moussa', email: 'private@example.invalid', phoneNumber: 'private' };
const clock = () => new Date(date + 'T09:00:00Z');
const category = (overrides = {}) => ({ _id: a, isActive: true, isVip: false, editorialSource: 'rdj_petit_journal',
  name: { fr: 'Le Petit Journal', en: 'The Daily Journal' }, description: { fr: 'Ancien texte statique', en: 'Old static copy' }, ...overrides });
function row(key, categoryId = a, source = 'rdj_petit_journal', editionDate = date) {
  const payload = { source, sourceId: String(key), editionDate, sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html',
    kind: 'match', title: { fr: 'OM contre Le Havre', en: 'OM against Le Havre' }, summary: { fr: 'Selection secrete', en: 'Secret pick' },
    startsAtUtc: editionDate + 'T19:00:00.000Z', sport: { key: 'football', name: 'Football' }, competition: { name: 'Ligue 1' },
    teams: { home: { name: 'OM', logo: 'https://images.example.invalid/om.png' }, away: { name: 'Le Havre' } }, status: 'upcoming',
    analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Le match est ouvert.'] }], en: [{ heading: 'Context', paragraphs: ['The game is open.'] }] },
    selection: { label: { fr: 'OM ou nul', en: 'OM or draw' }, odds: 1.5 } };
  return { _id: String(key).padStart(24, '0'), categoryId, editionDate, source, sourceId: String(key), payload,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), isPublished: true };
}
function setup(categories = [category()], rows = [row(1), row(2)]) {
  const state = { categories, rows, reviews: [], copies: [], openings: new Map(), subscription: false, access: false, unlocked: false, writes: 0, reads: 0, dates: [date] };
  const equal = (left, right) => String(left) === String(right);
  const repo = {
    categories: async () => state.categories,
    category: async key => { state.reads++; return state.categories.find(value => equal(value._id, key)); },
    items: async (ids, day) => state.rows.filter(value => ids.some(key => equal(key, value.categoryId)) && value.editionDate === day),
    item: async key => state.rows.find(value => equal(key, value._id)),
    availableDates: async () => state.dates,
    copies: async () => state.copies,
    hasCategoryAccess: async () => state.access,
    hasAnySubscription: async () => state.subscription,
    gate: async (reader, cat, subscribed) => ({ gated: !!cat.accessGate && !subscribed,
      locked: !!cat.accessGate && !subscribed && !(reader && state.unlocked), offers: [{ adsRequired: 1, durationMinutes: 60 }], state: null, unlockCount: 0 }),
    reviewSummaries: async (ids, day) => ids.map(key => {
      const reviews = state.reviews.filter(value => equal(value.categoryId, key) && value.editionDate === day);
      return { categoryId: key, count: reviews.length, averageRating: reviews.length ? reviews.reduce((sum, value) => sum + value.rating, 0) / reviews.length : 0 };
    }),
    openingCounts: async (ids, day) => ids.map(key => ({ categoryId: key, openingCount: [...state.openings.values()].filter(row => equal(row.categoryId, key) && row.editionDate === day).length })),
    recordOpening: async (categoryId, editionDate, openingId) => {
      const key = [categoryId, editionDate, openingId].join(':');
      const counted = !state.openings.has(key);
      if (counted) { state.openings.set(key, { categoryId, editionDate }); state.writes++; }
      return { counted, openingCount: [...state.openings.values()].filter(row => equal(row.categoryId, categoryId) && row.editionDate === editionDate).length };
    },
    reviews: async (key, day, { page, limit }) => {
      const reviews = state.reviews.filter(value => equal(value.categoryId, key) && value.editionDate === day).slice().reverse();
      return { total: reviews.length, rows: reviews.slice((page - 1) * limit, page * limit) };
    },
    userReview: async (key, day, reader) => state.reviews.find(value => equal(value.categoryId, key) && value.editionDate === day && equal(value.userId, reader)),
    upsertReview: async (key, day, reader, values) => {
      state.writes++;
      let review = await repo.userReview(key, day, reader);
      if (!review) { review = { _id: String(state.reviews.length + 1), categoryId: key, editionDate: day, userId: reader, createdAt: clock().toISOString() }; state.reviews.push(review); }
      Object.assign(review, values, { updatedAt: clock().toISOString() }); return review;
    },
  };
  return { state, repo, service: createEditorialService({ repository: repo, clock }) };
}
function noContent(value) {
  const forbidden = ['analysis', 'selection', 'odds', 'totalOdds', 'orderedNumbers', 'payload', 'summary', 'sourceUrl', 'contentHash', 'runners'];
  const visit = object => { if (!object || typeof object !== 'object') return; for (const [key, child] of Object.entries(object)) { assert.equal(forbidden.includes(key), false, key); visit(child); } };
  visit(value);
}

test('one card groups the Petit Journal matches; previews never leak analyses or picks', async () => {
  const { service } = setup([category(), category({ _id: b, editorialSource: 'rdj_turf_quinte' })], [row(1), row(2), row(3, b, 'rdj_turf_quinte')]);
  const data = await service.library();
  assert.equal(data.date, date); assert.equal(data.categories.length, 2);
  assert.equal(data.categories[0].itemCount, 2); assert.equal(data.categories[0].previewItems.length, 2);
  assert.equal(data.categories[1].itemCount, 1); assert.equal(data.categories[0].coverKey, 'rdj_petit_journal');
  assert.deepEqual(data.categories[0].reviewSummary, { count: 0, averageRating: null }); noContent(data);
  const edition = await service.edition(a, date); assert.equal(edition.itemCount, 2); noContent(edition);
  assert.equal(data.categories[0].description.includes('OM'), true);
  assert.equal(data.categories[0].description.includes('statique'), false);
});
test('zero reviews means no average; only a positive finite one-to-five rating is exposed', async () => {
  const { service, repo } = setup();
  for (const summary of [undefined, { count: 0, averageRating: 0 }, { count: 0, averageRating: 4 },
    { count: 0, averageRating: null }, { count: -1, averageRating: 4 }, { count: 2, averageRating: NaN },
    { count: 2, averageRating: Infinity }, { count: 2, averageRating: 0 }, { count: 2, averageRating: -2 },
    { count: 2, averageRating: 6 }]) {
    repo.reviewSummaries = async () => summary ? [{ categoryId: a, ...summary }] : [];
    assert.deepEqual((await service.library()).categories[0].reviewSummary, { count: 0, averageRating: null });
    assert.deepEqual((await service.edition(a, date)).reviewSummary, { count: 0, averageRating: null });
  }
  repo.reviewSummaries = async () => [{ categoryId: a, count: 2, averageRating: 4.25 }];
  assert.deepEqual((await service.library()).categories[0].reviewSummary, { count: 2, averageRating: 4.3 });
});
test('an anonymous VIP library is a safe storefront while both native and legacy reads enforce auth', async () => {
  const { service } = setup([category({ isVip: true, editorialSource: 'rdj_football_analysis' })], [row(1, a, 'rdj_football_analysis')]);
  const data = await service.library({ isVip: true });
  assert.equal(data.categories[0].locked, true); assert.equal(data.categories[0].requiresAuth, true); noContent(data);
  noContent(await service.edition(a, date));
  await assert.rejects(service.content(a, date), { statusCode: 401, errorCode: 'AUTH_TOKEN_MISSING' });
  await assert.rejects(service.feed({ isVip: true }), { statusCode: 401 });
  await assert.rejects(service.analysis('1'.padStart(24, '0')), { statusCode: 401 });
});
test('VIP access cannot be overridden by a date, a different package or public detail; entitled content remains native JSON', async () => {
  const { service, state } = setup([category({ isVip: true, editorialSource: 'rdj_football_analysis' })], [row(1, a, 'rdj_football_analysis')]);
  await assert.rejects(service.content(a, date, { user }), { statusCode: 403, errorCode: 'SUBSCRIPTION_REQUIRED' });
  state.access = true;
  const content = await service.content(a, date, { user, lang: 'en' });
  assert.equal(content.items[0].analysis.en[0].heading, 'Context'); assert.equal(content.items[0].selection.odds, 1.5);
  assert.equal(content.items[0].categoryId, a); assert.equal(content.requestedLanguage, 'en');
  noContent(await service.edition(a, date, { user }));
});
test('free rewarded gates protect the entire collection and subscribers bypass the existing gate', async () => {
  const { service, state } = setup([category({ accessGate: { type: 'ad_reward' } })]);
  assert.equal((await service.library()).categories[0].gate.type, 'ad_reward');
  await assert.rejects(service.content(a, date), { statusCode: 401 });
  await assert.rejects(service.content(a, date, { user }), { statusCode: 403, errorCode: 'RESOURCE_LOCKED' });
  state.unlocked = true; assert.equal((await service.content(a, date, { user })).items.length, 2);
  state.unlocked = false; state.subscription = true;
  assert.equal((await service.library({ user })).categories[0].gate, null);
  assert.equal((await service.content(a, date, { user })).items.length, 2);
});
test('ten latest real dates are sorted and deduplicated; an unavailable today is never silently relabelled', async () => {
  const { service, state } = setup();
  state.dates = ['2026-10-26', 'bad', '2026-02-30', date, date, ...Array.from({ length: 20 }, (_, index) => '2026-10-' + String(24 - index).padStart(2, '0'))].reverse();
  const result = await service.library(); assert.equal(result.availableDates.length, 10); assert.equal(result.availableDates[0], date); assert.equal(result.availableDates[9], '2026-10-16');
  state.rows.forEach(item => { item.editionDate = '2026-10-24'; item.payload.editionDate = '2026-10-24'; });
  const missing = await service.library(); assert.equal(missing.date, date); assert.equal(missing.categories[0].available, false);
  assert.equal(missing.categories[0].itemCount, 0); assert.equal(missing.categories[0].editionDate, date);
  assert.equal((await service.library({ date: '2026-10-24' })).categories[0].available, true);
});
test('date and category validation reject injection, invalid calendar days and future editions before detail DAL access', async () => {
  const { service, state } = setup();
  for (const day of ['2026-02-30', '25-10-2026', '2026-10-25T00:00:00Z', { $ne: null }, ['2026-10-25']]) {
    await assert.rejects(service.edition(a, day), { statusCode: 400 });
  }
  await assert.rejects(service.edition(a, '2026-10-26'), { statusCode: 404 });
  await assert.rejects(service.edition({ $ne: null }, date), { statusCode: 404 });
  await assert.rejects(service.library({ isVip: 'true' }), { statusCode: 400 });
  assert.equal(state.reads, 0);
});
test('inactive, archived, remapped and missing editions cannot be read or reviewed by a stale URL', async () => {
  for (const mutation of [{ isActive: false }, { catalogueArchived: true }, { editorialSource: null }, { editorialSource: 'rdj_turf_quinte' }]) {
    const { service, state } = setup(); Object.assign(state.categories[0], mutation);
    await assert.rejects(service.edition(a, date), { statusCode: 404 });
    await assert.rejects(service.content(a, date, { user }), { statusCode: 404 });
    await assert.rejects(service.putReview(a, date, { rating: 5 }, { user }), { statusCode: 404 });
  }
});
test('daily editorial copy is reused only while its original item hash binding remains valid', async () => {
  const { service, state } = setup();
  // This test specifically exercises the immutable copy fallback. Contextual
  // snippets are preferred when present; these source fields contain picks.
  for (const item of state.rows) {
    item.payload.summary = { fr: 'Notre choix : OM ou nul.', en: 'Our pick: OM or draw.' };
    item.payload.analysis = { fr: [{ heading: 'Choix', paragraphs: ['Notre choix : OM ou nul.'] }],
      en: [{ heading: 'Pick', paragraphs: ['Our pick: OM or draw.'] }] };
    item.contentHash = crypto.createHash('sha256').update(JSON.stringify(item.payload)).digest('hex');
  }
  const facts = factsFromBatch({ source: 'rdj_petit_journal', editionDate: date, items: state.rows.map(item => item.payload) });
  const copy = fallback(facts);
  state.copies.push({ appId: 'wintips', _id: `wintips:rdj_petit_journal:${date}`, source: 'rdj_petit_journal', editionDate: date,
    initialized: true, legacy: false, copy, copySha256: digest(copy), itemHashes: state.rows.map(item => ({ sourceId: item.sourceId, contentHash: item.contentHash })) });
  let result = await service.library({ lang: 'en' }); assert.equal(result.categories[0].editorialDescription, copy.body.en);
  assert.equal(result.categories[0].description, result.categories[0].editorialDescription);
  state.rows[0].payload.teams.home.name = 'Changed';
  result = await service.library(); assert.equal(result.categories[0].editorialDescription, result.categories[0].description); assert.equal(result.categories[0].description.includes('Changed'), true);
});
test('library and detail use factual daily team context from the exact category, source and edition', async () => {
  const selected = row(1), otherCategory = row(2, b), yesterday = row(3, a, 'rdj_petit_journal', '2026-10-24');
  selected.payload.summary = { fr: 'Marseille reste sur 4 victoires.', en: 'Marseille have recorded 4 wins.' };
  otherCategory.payload.summary = { fr: 'Contenu autre categorie.', en: 'Another category context.' };
  yesterday.payload.summary = { fr: 'Contexte seulement hier.', en: 'Yesterday context only.' };
  const { service } = setup([category()], [selected, otherCategory, yesterday]);
  for (const lang of ['fr', 'en']) {
    const card = (await service.library({ lang })).categories[0];
    assert.equal(card.description, `OM — Le Havre · ${selected.payload.summary[lang]}`);
    assert.equal(card.editorialDescription, card.description);
    assert.equal((await service.edition(a, date, { lang })).description, card.description);
    assert.equal(/hier|Yesterday|autre|Another/.test(card.description), false);
  }
});

test('ten matches keep one short complete card hook while the reader retains every full analysis', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => row(index + 1));
  for (const [index, item] of rows.entries()) {
    item.payload.teams = { home: { name: `Club ${index + 1}` }, away: { name: `Rival ${index + 1}` } };
    item.payload.summary = { fr: `Club ${index + 1} reste sur 4 victoires.`, en: `Club ${index + 1} have recorded 4 wins.` };
    item.payload.analysis.fr[0].paragraphs.push('Analyse complete conservee dans la lecture.');
  }
  const before = JSON.parse(JSON.stringify(rows));
  const { service } = setup([category()], rows);
  for (const lang of ['fr', 'en']) {
    const library = (await service.library({ lang })).categories[0];
    const edition = await service.edition(a, date, { lang });
    const expected = `Club 1 \u2014 Rival 1 \u00b7 ${rows[0].payload.summary[lang]}`;
    for (const card of [library, edition]) {
      assert.equal(card.description, expected);
      assert.equal(card.editorialDescription, expected);
      assert.ok([...card.description].length <= 140);
      assert.doesNotMatch(card.description, /\u2026|\.\.\.|Club 2/);
      assert.equal(card.itemCount, 10);
      assert.equal(card.previewItems.length, 10);
    }
    const content = await service.content(a, date, { lang });
    assert.equal(content.items.length, 10);
    for (const [index, item] of content.items.entries()) {
      assert.deepEqual(item.analysis, before[index].payload.analysis);
      assert.deepEqual(item.selection, before[index].payload.selection);
    }
  }
  assert.deepEqual(rows, before);
});
test('review input allows one to five integer stars and plain bounded comments only', () => {
  for (const input of [{ rating: 0 }, { rating: 6 }, { rating: '5' }, { rating: 2.5 }, { rating: 5, userId: user._id },
    { rating: 5, comment: '<script>x</script>' }, { rating: 5, comment: 'x'.repeat(1501) }, { rating: 5, comment: '\u202ehidden' }, { rating: 5, comment: { $gt: '' } }]) assert.throws(() => reviewInput(input), { statusCode: 400 });
  assert.deepEqual(reviewInput({ rating: 4, comment: ' Merci ! ' }), { rating: 4, comment: 'Merci !' });
  assert.deepEqual(reviewInput({ rating: 3 }), { rating: 3, comment: '' });
});
test('review upserts are scoped to the authenticated reader, category and edition; public response has no user identifiers', async () => {
  const { service, state } = setup();
  await assert.rejects(service.putReview(a, date, { rating: 5 }), { statusCode: 401 }); assert.equal(state.writes, 0);
  const first = await service.putReview(a, date, { rating: 5, comment: 'Bien' }, { user });
  const second = await service.putReview(a, date, { rating: 3, comment: 'Modifie' }, { user });
  assert.equal(first.review.id, second.review.id); assert.equal(state.reviews.length, 1); assert.equal(second.review.authorName, 'Moussa');
  assert.equal(second.review.isMine, true); assert.equal(second.review.rating, 3);
  for (const value of ['userId', 'email', 'phoneNumber', user._id]) assert.equal(JSON.stringify(second).includes(value), false);
  const other = await service.putReview(a, date, { rating: 4 }, { user: { _id: c, pseudo: '<b>bad</b>' }, lang: 'en' });
  assert.equal(other.review.authorName, 'Reader'); assert.equal(state.reviews.length, 2);
  assert.deepEqual((await service.edition(a, date)).reviewSummary, { count: 2, averageRating: 3.5 });
});
test('paywall access is also required to submit an edition review', async () => {
  const { service, state } = setup([category({ isVip: true, editorialSource: 'rdj_football_analysis' })], [row(1, a, 'rdj_football_analysis')]);
  await assert.rejects(service.putReview(a, date, { rating: 5 }, { user }), { statusCode: 403, errorCode: 'SUBSCRIPTION_REQUIRED' });
  assert.equal(state.writes, 0); state.access = true; await service.putReview(a, date, { rating: 5 }, { user }); assert.equal(state.writes, 1);
});
test('review pagination is bounded and stable; own review is returned even outside the visible page', async () => {
  const { service } = setup();
  for (let index = 0; index < 5; index++) await service.putReview(a, date, { rating: 4 }, { user: { _id: String(index), pseudo: 'Reader' + index } });
  const result = await service.reviews(a, date, { page: '2', limit: '2', user: { _id: '0' } });
  assert.equal(result.total, 5); assert.equal(result.items.length, 2); assert.equal(result.hasNext, true); assert.equal(result.myReview.isMine, true);
  const last = await service.reviews(a, date, { page: '3', limit: '2' }); assert.equal(last.items.length, 1); assert.equal(last.hasNext, false); assert.equal(last.myReview, null);
  for (const args of [['0', '10'], ['-1', '10'], ['01', '10'], ['1', '21'], ['1.5', '10'], [{ $gt: 0 }, '10'], ['1001', '10']]) assert.throws(() => pagination(...args), { statusCode: 400 });
});
test('repository refuses review writes without the exact provisioned unique index', async () => {
  for (const indexes of [[], [{ name: 'editorial_review_reader_edition_unique', unique: true, key: { userId: 1 } }]]) {
    let writes = 0;
    const repository = createEditorialRepository({ EditorialReview: { collection: { listIndexes: () => ({ toArray: async () => indexes }) }, findOneAndUpdate() { writes++; } } });
    await assert.rejects(repository.upsertReview(a, date, user._id, { rating: 5, authorName: 'Reader' }), { statusCode: 503 });
    assert.equal(writes, 0);
  }
});
test('repository duplicate insert race converges on the same unique identity without inserting again', async () => {
  const calls = [], key = { categoryId: 1, editionDate: 1, userId: 1 };
  const repository = createEditorialRepository({ EditorialReview: {
    collection: { listIndexes: () => ({ toArray: async () => [{ name: 'editorial_review_reader_edition_unique', key, unique: true }] }) },
    findOneAndUpdate(filter, update, options) { calls.push({ filter, update, options }); return { lean: async () => {
      if (calls.length === 1) throw Object.assign(new Error('duplicate'), { code: 11000 });
      return { _id: a };
    } }; },
  } });
  assert.equal((await repository.upsertReview(a, date, user._id, { rating: 4, comment: 'Text', authorName: 'Reader' }))._id, a);
  assert.equal(calls.length, 2); assert.equal(calls[0].options.upsert, true); assert.equal(calls[1].options.upsert, undefined);
  assert.deepEqual(calls[0].filter, calls[1].filter); assert.deepEqual(calls[0].filter, { categoryId: a, editionDate: date, userId: user._id });
});
test('date DAL groups only real published category editions and bounds history to ten', async () => {
  let pipeline;
  const repository = createEditorialRepository({ EditorialItem: { aggregate(value) { pipeline = value; return Promise.resolve([{ _id: date }]); } } });
  assert.deepEqual(await repository.availableDates([a], date, 99), [date]);
  assert.deepEqual(pipeline[0], { $match: { categoryId: { $in: [a] }, isPublished: true, editionDate: { $lte: date } } });
  assert.deepEqual(pipeline.at(-1), { $limit: 10 });
});
test('currentDate follows the server publisher calendar independently of a selected archive or device timezone', async () => {
  const { repo } = setup();
  const service = createEditorialService({ repository: repo, clock: () => new Date('2026-10-25T23:30:00Z') });
  const library = await service.library({ date });
  assert.equal(library.date, date); assert.equal(library.currentDate, '2026-10-26');
  const detail = await service.edition(a, date);
  assert.equal(detail.editionDate, date); assert.equal(detail.currentDate, '2026-10-26');
});
test('library captures one publisher date before async reads even when the request crosses Paris midnight', async () => {
  const { repo, state } = setup();
  let instant = '2026-10-25T22:59:59.999Z', calls = 0;
  const categories = repo.categories;
  repo.categories = async () => { instant = '2026-10-25T23:00:00.001Z'; return categories(); };
  state.dates = ['2026-10-25', '2026-10-26'];
  let ceiling;
  repo.availableDates = async (ids, requestDate) => { ceiling = requestDate; return state.dates; };
  const service = createEditorialService({ repository: repo, clock: () => { calls++; return new Date(instant); } });
  const result = await service.library();
  assert.equal(calls, 1); assert.equal(result.date, '2026-10-25'); assert.equal(result.currentDate, '2026-10-25');
  assert.equal(ceiling, '2026-10-25'); assert.deepEqual(result.availableDates, ['2026-10-25']);
  for (const category of result.categories) assert.equal(category.currentDate, result.currentDate);
  assert.equal(result.categories[0].itemCount, 2);
});
test('detail and each native/review operation capture the publisher clock exactly once per request', async () => {
  for (const operation of ['edition', 'content', 'reviews', 'putReview']) {
    const { repo } = setup();
    let instant = '2026-10-25T22:59:59.999Z', calls = 0;
    const category = repo.category;
    repo.category = async key => { instant = '2026-10-25T23:00:00.001Z'; return category(key); };
    const service = createEditorialService({ repository: repo, clock: () => { calls++; return new Date(instant); } });
    const result = operation === 'putReview' ? await service.putReview(a, date, { rating: 4 }, { user }) :
      await service[operation](a, date, { user });
    assert.equal(calls, 1, operation);
    if (operation === 'edition') assert.equal(result.currentDate, date);
  }
});
test('review writes reject partial, sparse, collated, expiring, hidden, wrongly ordered or otherwise incompatible unique indexes', async () => {
  const { REVIEW_IDENTITY_INDEX } = require('../src/api/services/common/editorialIndexIdentity');
  const alterations = [
    { partialFilterExpression: { rating: { $gte: 3 } } }, { sparse: true }, { collation: { locale: 'en', strength: 2 } },
    { expireAfterSeconds: 0 }, { hidden: true }, { unique: 'true' },
    { key: { userId: 1, categoryId: 1, editionDate: 1 } }, { key: { categoryId: 1, editionDate: 1 } },
    { key: { categoryId: 1, editionDate: 1, userId: 1, source: 1 } },
  ];
  for (const alteration of alterations) {
    let writes = 0;
    const repository = createEditorialRepository({ EditorialReview: {
      collection: { listIndexes: () => ({ toArray: async () => [{ ...REVIEW_IDENTITY_INDEX, ...alteration }] }) },
      findOneAndUpdate() { writes++; throw new Error('Unexpected mutation'); },
    } });
    await assert.rejects(repository.upsertReview(a, date, user._id, { rating: 4, comment: '', authorName: 'Reader' }), { statusCode: 503 });
    assert.equal(writes, 0);
  }
});
test('the provisioning inspection and runtime use the same exact functional index definition', async () => {
  const { REVIEW_IDENTITY_INDEX, matchesIndexDefinition } = require('../src/api/services/common/editorialIndexIdentity');
  const { inspect, COLLECTIONS } = require('../tools/editorial-indexes.cjs');
  assert.equal(matchesIndexDefinition({ ...REVIEW_IDENTITY_INDEX, v: 2, ns: 'local.editorialreviews', sparse: false, hidden: false }, REVIEW_IDENTITY_INDEX), true);
  for (const alteration of [{ partialFilterExpression: { rating: 5 } }, { sparse: true }, { collation: { locale: 'en' } }, { expireAfterSeconds: 0 }, { hidden: true }]) {
    const collections = Object.fromEntries(Object.entries(COLLECTIONS).map(([name, indexes]) => [name, indexes.map(index => JSON.parse(JSON.stringify(index)))]));
    Object.assign(collections.editorialreviews[0], alteration);
    const result = await inspect({ collection: name => ({ listIndexes: () => ({ toArray: async () => collections[name] }) }) });
    assert.equal(result.ready, false); assert.deepEqual(result.conflicts, ['editorial_review_reader_edition_unique']);
    assert.equal(matchesIndexDefinition(collections.editorialreviews[0], REVIEW_IDENTITY_INDEX), false);
  }
});

const firstOpening = '4f5ca989-95f4-4e8e-a335-73de107ebc67';
const secondOpening = '928d0143-7ea9-4156-9872-073f44a70ceb';
test('opening action accepts only an exact UUIDv4 body and canonicalizes its casing before DAL', async () => {
  const { service, state } = setup();
  for (const body of [null, [], {}, { openingId: 4 }, { openingId: '' }, { openingId: { $ne: null } },
    { openingId: firstOpening, userId: user._id }, { openingId: firstOpening + ' ' }, { openingId: firstOpening + '\n' },
    Object.assign(Object.create({ openingId: firstOpening }), { other: true }),
    { openingId: '4f5ca989-95f4-1e8e-a335-73de107ebc67' }, { openingId: '4f5ca989-95f4-4e8e-7335-73de107ebc67' }]) {
    await assert.rejects(service.open(a, date, body), { statusCode: 400 });
  }
  assert.equal(state.reads, 0); assert.equal(state.writes, 0);
  assert.equal(openingInput({ openingId: firstOpening.toUpperCase() }), firstOpening);
});

test('only explicit authorized openings count, shared by library/detail and all reader languages', async () => {
  const { service, state } = setup();
  assert.equal((await service.library()).categories[0].openingCount, 0);
  assert.equal((await service.edition(a, date)).openingCount, 0);
  await service.content(a, date); await service.reviews(a, date, {});
  assert.equal(state.writes, 0);
  assert.deepEqual(await service.open(a, date, { openingId: firstOpening }), { categoryId: a, editionDate: date, openingCount: 1, counted: true });
  assert.equal((await service.open(a, date, { openingId: firstOpening.toUpperCase() }, { user })).counted, false);
  assert.equal((await service.open(a, date, { openingId: secondOpening }, { user })).openingCount, 2);
  assert.equal((await service.library({ lang: 'en' })).categories[0].openingCount, 2);
  assert.equal((await service.edition(a, date, { lang: 'fr', user })).openingCount, 2);
  assert.equal(state.writes, 2);
});

test('opening a VIP edition requires the current category entitlement before any counted write', async () => {
  const { service, state } = setup([category({ isVip: true, editorialSource: 'rdj_football_analysis' })], [row(1, a, 'rdj_football_analysis')]);
  await assert.rejects(service.open(a, date, { openingId: firstOpening }), { statusCode: 401 });
  await assert.rejects(service.open(a, date, { openingId: firstOpening }, { user }), { statusCode: 403, errorCode: 'SUBSCRIPTION_REQUIRED' });
  assert.equal(state.writes, 0);
  state.access = true;
  assert.equal((await service.open(a, date, { openingId: firstOpening }, { user })).openingCount, 1);
  state.access = false;
  await assert.rejects(service.open(a, date, { openingId: secondOpening }, { user }), { statusCode: 403 });
  assert.equal(state.writes, 1);
});

test('opening a gated free edition respects anonymous/user/subscriber gates', async () => {
  const { service, state } = setup([category({ accessGate: { type: 'ad_reward' } })]);
  await assert.rejects(service.open(a, date, { openingId: firstOpening }), { statusCode: 401 });
  await assert.rejects(service.open(a, date, { openingId: firstOpening }, { user }), { statusCode: 403, errorCode: 'RESOURCE_LOCKED' });
  assert.equal(state.writes, 0);
  state.unlocked = true;
  assert.equal((await service.open(a, date, { openingId: firstOpening }, { user })).counted, true);
  state.unlocked = false; state.subscription = true;
  assert.equal((await service.open(a, date, { openingId: secondOpening }, { user })).openingCount, 2);
});

test('opening missing, future, inactive, archived or remapped editions never writes receipts', async () => {
  for (const mutation of [{ isActive: false }, { catalogueArchived: true }, { editorialSource: null }, { editorialSource: 'rdj_turf_quinte' }]) {
    const { service, state } = setup(); Object.assign(state.categories[0], mutation);
    await assert.rejects(service.open(a, date, { openingId: firstOpening }, { user }), { statusCode: 404 });
    assert.equal(state.writes, 0);
  }
  const { service, state } = setup();
  await assert.rejects(service.open(a, '2026-10-26', { openingId: firstOpening }), { statusCode: 404 });
  await assert.rejects(service.open(a, '2026-10-24', { openingId: firstOpening }), { statusCode: 404 });
  await assert.rejects(service.open({ $ne: null }, date, { openingId: firstOpening }), { statusCode: 404 });
  assert.equal(state.writes, 0);
});

test('the opening operation freezes the publisher day exactly once before async DAL reads', async () => {
  const { repo } = setup(); let calls = 0, instant = '2026-10-25T22:59:59.999Z';
  const original = repo.category; repo.category = async key => { instant = '2026-10-25T23:00:00.001Z'; return original(key); };
  const service = createEditorialService({ repository: repo, clock: () => { calls++; return new Date(instant); } });
  assert.equal((await service.open(a, date, { openingId: firstOpening })).editionDate, date);
  assert.equal(calls, 1);
});
