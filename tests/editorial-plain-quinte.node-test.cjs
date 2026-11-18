// Native BigWin Quinté text transport; no HTTP, database or publisher mutation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch, completeEnglishWithFallback, requireCompleteEnglish } = require('../src/api/services/common/editorialValidation');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { sourceByKey } = require('../src/api/services/common/editorialSources');

const day = '2026-11-19', source = 'rdj_turf_quinte', categoryId = 'a'.repeat(24);
const clock = () => new Date(`${day}T21:00:00Z`);
function article() {
  // Same fields as editorial_worker/plain_quinte.py, with the full narrative.
  return {
    source, editionDate: day, sourceId: `${day}-R1C3`,
    sourceUrl: 'https://www.ruedesjoueurs.com/turf/pronostic-turf/course/19-11-2026/R1/C3/prix-test.html',
    kind: 'article', title: { fr: 'Le Quinté du jour : Prix Test' },
    summary: { fr: 'Les chances des concurrents au départ du Quinté.' },
    startsAtUtc: null, status: 'unknown', sport: { key: 'horse_racing', name: 'Courses hippiques' },
    competition: { name: 'Vincennes' },
    analysis: { fr: [{ heading: 'Le Quinté du jour : Prix Test', paragraphs: [
      'Le favori revient sur une piste qu’il connaît et conserve une première chance.',
      'Le deuxième concurrent peut profiter d’un parcours plus favorable.\nLe texte intégral reste présent.',
      'Sélection : 4 - 7 - 2 - 9 - 1',
    ] }] },
    selection: { label: { fr: 'Sélection Quinté+', en: 'Quinté+ selection' }, odds: null },
  };
}
const batch = (item = article()) => ({ source, editionDate: day, items: [item] });
const change = mutate => { const value = batch(); mutate(value, value.items[0]); return value; };
function oldStructuredRace() {
  const item = article();
  Object.assign(item, { kind: 'horse_racing', startsAtUtc: `${day}T15:00:00Z`, status: 'upcoming',
    race: { meetingNumber: 1, raceNumber: 3, name: 'Prix Test', racecourse: 'Vincennes', discipline: 'Attele',
      distanceMeters: 2850, runnersCount: 2, runners: [{ number: 1, name: 'Cheval A' }, { number: 2, name: 'Cheval B' }] },
    selection: { label: { fr: 'Selection source' }, odds: null, orderedNumbers: [2, 1] } });
  return item;
}

test('Quinté catalogue admits native text in addition to the unchanged structured format', () => {
  assert.deepEqual(sourceByKey(source).kinds, ['horse_racing', 'article']);
  assert.equal(sourceByKey(source).access, 'free');
  assert.equal(sourceByKey(source).selectable, true);
});

test('complete Quinté text publishes throughout its Paris edition day without departure, runners or results', () => {
  const original = batch(), snapshot = structuredClone(original);
  for (const instant of [`${day}T05:00:00Z`, `${day}T15:00:00Z`, `${day}T22:59:59Z`]) {
    const value = validateBatch(original, new Date(instant)).items[0];
    assert.equal(value.kind, 'article');
    assert.equal(value.sport.key, 'horse_racing');
    assert.equal(value.startsAtUtc, null);
    assert.equal(value.status, 'unknown');
    assert.equal(value.race, undefined);
    assert.equal(value.selection.orderedNumbers, undefined);
    assert.equal(value.selection.odds, null);
    assert.deepEqual(value.analysis.fr, original.items[0].analysis.fr);
  }
  assert.deepEqual(original, snapshot);
});

test('an untranslated full analysis uses the same original fallback as the existing text reader', () => {
  const result = validateBatch(batch(), clock());
  completeEnglishWithFallback(result.items);
  assert.doesNotThrow(() => requireCompleteEnglish(result.items));
  assert.deepEqual(result.items[0].analysis.en, result.items[0].analysis.fr);
});

test('only the current Europe/Paris edition is importable, including the UTC midnight boundary', () => {
  assert.doesNotThrow(() => validateBatch(batch(), new Date('2026-11-18T23:01:00Z')));
  for (const now of ['2026-11-18T22:59:59Z', '2026-11-19T23:00:00Z'])
    assert.throws(() => validateBatch(batch(), new Date(now)), /edition du jour Europe\/Paris/);
  for (const editionDate of ['2026-11-18', '2026-11-20', '2026-02-30'])
    assert.throws(() => validateBatch({ ...batch(), editionDate }, clock()));
});

test('dated course URL and source identity must name the same edition, meeting and race', () => {
  for (const mutate of [
    (_, item) => { item.sourceUrl = item.sourceUrl.replace('19-11-2026', '18-11-2026'); },
    (_, item) => { item.sourceId = `${day}-R2C3`; },
    (_, item) => { item.sourceId = `${day}-R1C4`; },
    (_, item) => { item.sourceId = '2026-11-18-R1C3'; },
    (_, item) => { item.sourceUrl = item.sourceUrl.replace('/R1/', '/R0/'); item.sourceId = `${day}-R0C3`; },
    (_, item) => { item.sourceUrl = item.sourceUrl.replace('/C3/', '/C100/'); item.sourceId = `${day}-R1C100`; },
    (_, item) => { item.sourceUrl = 'https://www.ruedesjoueurs.com/turf/pronostic-turf.html'; },
    (_, item) => { item.sourceUrl = 'https://www.ruedesjoueurs.com/turf/pronostic-turf/pronostics-quinte/quinte-du-19-11-2026.html'; },
  ]) assert.throws(() => validateBatch(change(mutate), clock()), /Identite ou date de course/);
});

test('canonical publisher constraints reject alternate hosts, credentials, query strings and scripts', () => {
  for (const url of [
    article().sourceUrl.replace('https:', 'http:'),
    article().sourceUrl.replace('www.ruedesjoueurs.com', 'www.ruedesjoueurs.com.evil.invalid'),
    article().sourceUrl.replace('https://', 'https://password@'),
    article().sourceUrl + '?redirect=https://evil.invalid',
    article().sourceUrl + '#results',
    'javascript:alert(1)',
  ]) assert.throws(() => validateBatch(change((_, item) => { item.sourceUrl = url; }), clock()));
});

test('text exception is limited to the Quinté source and horse racing sport', () => {
  assert.throws(() => validateBatch(change((_, item) => { item.sport.key = 'football'; }), clock()), /Sport hippique requis/);
  for (const sport of [undefined, null, {}, { key: 'horse_racing' }, { key: '', name: 'Courses hippiques' }])
    assert.throws(() => validateBatch(change((_, item) => { item.sport = sport; }), clock()));
  for (const other of ['rdj_football_analysis', 'rdj_multisport_analysis', 'rdj_football_combine', 'wintips_daily_vip']) {
    const value = batch(); value.source = other; value.items[0].source = other;
    assert.throws(() => validateBatch(value, clock()));
  }
  for (const legacy of ['basketusa_nba', 'rdj_nba', 'rdj_tennis']) {
    const value = batch(); value.source = legacy; value.items[0].source = legacy;
    assert.throws(() => validateBatch(value, clock()), { statusCode: 403 });
  }
});

test('native article cannot carry structured event or ticket execution fields', () => {
  for (const [key, value] of [
    ['startsAtUtc', `${day}T15:00:00Z`], ['race', {}], ['legs', []], ['scheduleProof', {}],
    ['clockReconciliation', {}], ['editionConvention', 'following_night'], ['curation', {}],
    ['sourcePublication', {}], ['sourceTimeLabel', '15:00'],
  ]) assert.throws(() => validateBatch(change((_, item) => { item[key] = value; }), clock()), key);
});

test('analysis must be nonempty complete plain text; injected or malformed fields are rejected', () => {
  for (const mutate of [
    (_, item) => { item.analysis.fr[0].paragraphs = ['<script>bad()</script>']; },
    (_, item) => { item.analysis.fr[0].paragraphs = ['<img src="https://evil.invalid/track">']; },
    (_, item) => { item.analysis.fr = []; },
    (_, item) => { item.analysis.fr[0].paragraphs = []; },
    (_, item) => { item.analysis.fr[0].paragraphs = [{ $ne: null }]; },
    (_, item) => { item.analysis.fr[0].paragraphs = ['bad\u0000text']; },
    (_, item) => { item.$where = 'dangerous'; },
    (_, item) => { item.source = 'rdj_petit_journal'; },
    (_, item) => { item.editionDate = '2026-11-18'; },
    (_, item) => { item.artworkUrl = 'https://127.0.0.1/private'; },
    (value) => { value.categoryId = 'injected'; },
  ]) assert.throws(() => validateBatch(change(mutate), clock()));
});

test('the old structured horse path retains runner, selection and departure validation', () => {
  const before = new Date(`${day}T14:30:00Z`);
  const item = validateBatch(batch(oldStructuredRace()), before).items[0];
  assert.deepEqual(item.selection.orderedNumbers, [2, 1]);
  assert.equal(item.race.runners.length, 2);
  assert.throws(() => validateBatch(batch(oldStructuredRace()), new Date(`${day}T14:30:01Z`)), /30 minutes/);
  assert.throws(() => validateBatch(batch(oldStructuredRace()), clock()), /30 minutes/);
  for (const mutate of [
    item => { item.race.runners = []; },
    item => { item.selection.orderedNumbers = [99]; },
    item => { item.selection.orderedNumbers = []; },
    item => { item.status = 'finished'; },
  ]) { const value = oldStructuredRace(); mutate(value); assert.throws(() => validateBatch(batch(value), before)); }
});

function inMemory() {
  const category = { _id: categoryId, isActive: true, isVip: false, catalogueArchived: false, editorialSource: source,
    name: { fr: 'Quinté du jour', en: 'Daily Quinté' }, description: { fr: '', en: '' } };
  const rows = [];
  let writes = 0;
  const repository = {
    categories: async () => [category], category: async () => category,
    availableDates: async () => rows.length ? [day] : [],
    sourceWindowItems: async (ids, date) => rows.filter(row => ids.includes(row.categoryId) && row.editionDate === date),
    items: async (ids, date) => rows.filter(row => ids.includes(row.categoryId) && row.editionDate === date),
    item: async key => rows.find(row => row._id === key),
    hasAnySubscription: async () => false, hasCategoryAccess: async () => false,
    gate: async () => ({ gated: false, locked: false }),
    reviewSummaries: async () => [],
    upsertBatch: async operations => {
      writes++;
      let inserted = 0;
      for (const { updateOne: operation } of operations) {
        let row = rows.find(row => Object.entries(operation.filter).every(([key, value]) => row[key] === value));
        if (!row) { row = { _id: String(rows.length + 1).padStart(24, '0'), ...operation.filter, ...operation.update.$setOnInsert }; rows.push(row); inserted++; }
        Object.assign(row, operation.update.$set);
      }
      return { upsertedCount: inserted, matchedCount: operations.length - inserted };
    },
  };
  const service = createEditorialService({ repository, clock, importEnabled: () => true });
  return { service, rows, category, writes: () => writes };
}

test('late native Quinté import appears in free catalogue and content, with no analysis leak in public previews', async () => {
  const h = inMemory();
  const imported = await h.service.importBatch(batch());
  assert.equal(imported.imported, 1);
  assert.equal(h.rows[0].startsAtUtc, null);
  const library = await h.service.library();
  assert.equal(library.categories[0].available, true);
  assert.equal(library.categories[0].itemCount, 1);
  assert.equal(library.categories[0].previewItems[0].kind, 'article');
  assert.equal(JSON.stringify(library).includes(article().analysis.fr[0].paragraphs[0]), false);
  const content = await h.service.content(categoryId, day);
  assert.deepEqual(content.items[0].analysis.fr, article().analysis.fr);
  assert.equal(content.items[0].sport.key, 'horse_racing');
  h.rows[0].notificationState = 'sent';
  assert.equal((await h.service.importBatch(batch())).inserted, 0);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].notificationState, 'sent');
});

test('invalid articles and inactive category mappings cannot write or expose a Quinté', async () => {
  const h = inMemory();
  const invalid = change((_, item) => { item.sourceId = `${day}-R2C3`; });
  await assert.rejects(h.service.importBatch(invalid));
  assert.equal(h.writes(), 0);
  h.category.isActive = false;
  assert.equal((await h.service.importBatch(batch())).ignored, true);
  assert.equal(h.writes(), 0);
  assert.deepEqual((await h.service.library()).categories, []);
});

test('published native Quinté has a ready read-only worker inventory without an event clock', async () => {
  const h = inMemory();
  await h.service.importBatch(batch());
  const before = structuredClone(h.rows), writes = h.writes();
  const config = await h.service.workerConfig();
  const window = config.publishedSourceWindows.sources.find(row => row.source === source);
  assert.equal(window.ready, true);
  assert.equal(window.count, 1);
  assert.equal(window.categoryId, categoryId);
  assert.equal(window.latestStartsAtUtc, null);
  assert.deepEqual(window.items, [{ sourceId: `${day}-R1C3`, sourceUrl: article().sourceUrl, kind: 'article', startsAtUtc: null }]);
  assert.equal(config.sources.find(row => row.key === source).kinds.includes('article'), true);
  assert.equal(/analysis|selection|contentHash|paragraphs/.test(JSON.stringify(window)), false);
  assert.equal(h.writes(), writes);
  assert.deepEqual(h.rows, before);
});
