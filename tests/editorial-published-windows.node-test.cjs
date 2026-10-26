// Read-only service/repository contracts; no database, HTTP or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
const { normalizeItem } = require('../src/api/services/common/editorialValidation');
const day = '2026-10-24', petit = 'rdj_petit_journal', turf = 'rdj_turf_quinte';
const clone = value => structuredClone(value);
const category = (source, digit) => ({ _id: digit.repeat(24), isActive: true, isVip: false, catalogueArchived: false, editorialSource: source });
const cats = [category(petit, 'a'), category(turf, 'b')];
function payload(source = petit, number = '12345') {
  const value = { source, editionDate: day, sourceId: number, kind: 'match',
    sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74782-le-petit-journal-du-parieur-samedi-24-octobre-2026.html',
    startsAtUtc: `${day}T16:30:00Z`, status: 'upcoming', sport: { key: 'football', name: 'Football' }, competition: { name: 'Premier League' },
    teams: { home: { name: 'Chelsea', logo: 'https://img.ruedesjoueurs.com/img/8455-2.png' }, away: { name: 'Tottenham', logo: 'https://img.ruedesjoueurs.com/img/8586-2.png' } },
    title: { fr: 'Chelsea contre Tottenham', en: 'Chelsea versus Tottenham' }, summary: { fr: 'Analyse du match.', en: 'Match analysis.' },
    analysis: { fr: [{ heading: 'Forme', paragraphs: ['Analyse originale.'] }], en: [{ heading: 'Form', paragraphs: ['Original analysis.'] }] },
    selection: { label: { fr: 'Victoire Chelsea', en: 'Chelsea to win' }, odds: 1.66 } };
  if (source === turf) Object.assign(value, { sourceId: `${day}-R1C3`, kind: 'horse_racing',
    sourceUrl: 'https://www.ruedesjoueurs.com/turf/pronostic-turf/course/24-10-2026/R1/C3/prix-test.html',
    sport: { key: 'horse_racing', name: 'Courses hippiques' }, teams: undefined,
    race: { meetingNumber: 1, raceNumber: 3, name: 'Prix Test', racecourse: 'Test', discipline: 'Attele', distanceMeters: 2000, runnersCount: 2,
      runners: [{ number: 1, name: 'Cheval A' }, { number: 2, name: 'Cheval B' }] },
    selection: { label: { fr: 'Selection', en: 'Selection' }, odds: null, orderedNumbers: [2, 1] } });
  return normalizeItem(value, source, day);
}
function row(source = petit, number = '12345') {
  const p = payload(source, number);
  return { categoryId: cats[source === petit ? 0 : 1]._id, source, editionDate: day, sourceId: p.sourceId,
    kind: p.kind, startsAtUtc: new Date(p.startsAtUtc), payload: p, isPublished: true,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex') };
}
function harness(rows = [row(), row(turf)], categories = clone(cats), when = `${day}T21:00:00Z`) {
  const calls = [];
  const repository = { categories: async () => categories, sourceWindowItems: async (...args) => { calls.push(args); return rows; },
    ticketState: async editionDate => ({ ready: true, editionDate }), upsertBatch: () => { throw new Error('must not write'); } };
  return { repository, rows, categories, calls, service: createEditorialService({ repository, clock: () => new Date(when), importEnabled: () => true }) };
}
const windowFor = (config, source = petit) => config.publishedSourceWindows.sources.find(row => row.source === source);

test('published Free windows expose only bounded identities, never prose or write', async () => {
  const h = harness(), before = clone(h.rows), config = await h.service.workerConfig();
  assert.equal(config.publishedSourceWindows.version, 'published-source-windows-v1');
  assert.equal(config.date, day); assert.equal(config.ticketState.ready, true);
  assert.deepEqual(h.calls, [[cats.map(c => c._id), day]]);
  for (const source of [petit, turf]) { const w = windowFor(config, source); assert.equal(w.ready, true); assert.equal(w.count, 1); assert.equal(w.latestStartsAtUtc, `${day}T16:30:00.000Z`); }
  assert.deepEqual(h.rows, before);
  assert.equal(/analysis|selection|contentHash|notification|title/.test(JSON.stringify(config.publishedSourceWindows)), false);
});
test('optional database failure or unavailable method is unknown, preserving config and VIP', async () => {
  for (const missing of [false, true]) {
    const h = harness(); h.categories.push({ ...category('rdj_multisport_analysis', 'c'), isVip: true });
    if (missing) delete h.repository.sourceWindowItems;
    else h.repository.sourceWindowItems = async () => { throw new Error('private database detail'); };
    const c = await h.service.workerConfig();
    assert.equal(c.importEnabled, true); assert.equal(c.sources.some(s => s.key === 'rdj_multisport_analysis'), true);
    assert.equal(c.publishedSourceWindows.sources.every(w => w.ready === false), true);
    assert.equal(JSON.stringify(c).includes('private database detail'), false);
  }
});
test('each source is independent; partial/invalid published rows cannot become a window', async () => {
  for (const mutation of [r => { r.isPublished = false; }, r => { r.contentHash = '0'.repeat(64); },
    r => { r.editionDate = '2026-10-23'; }, r => { r.source = turf; }, r => { r.sourceId = 'wrong'; },
    r => { r.startsAtUtc = new Date(`${day}T17:00:00Z`); }, r => { r.kind = 'horse_racing'; }]) {
    const h = harness(); mutation(h.rows[0]); const c = await h.service.workerConfig();
    assert.equal(windowFor(c).ready, false); assert.equal(windowFor(c, turf).ready, true);
  }
});
test('mapping must be uniquely active, Free, unarchived and a real category ID', async () => {
  for (const mutation of [c => { c.isVip = true; }, c => { c.isActive = false; }, c => { c.catalogueArchived = true; }, c => { c._id = 'bad'; }]) {
    const h = harness(); mutation(h.categories[0]); assert.equal(windowFor(await h.service.workerConfig()).ready, false);
  }
  const h = harness(); h.categories.push({ ...h.categories[0], _id: 'd'.repeat(24) });
  assert.equal(windowFor(await h.service.workerConfig()).ready, false);
});
test('empty, duplicate, oversized and unpublished-extra inventories are never proven', async () => {
  for (const rows of [[], [row(), row()], Array.from({ length: 9 }, (_, i) => row(petit, String(12000 + i))),
    [row(), { ...row(petit, '12346'), isPublished: false }]]) {
    assert.equal(windowFor(await harness(rows).service.workerConfig()).ready, false);
  }
  assert.equal((await harness(Array(51).fill(row())).service.workerConfig()).publishedSourceWindows.sources.every(w => !w.ready), true);
});
test('published source identity does not depend on translation availability or quality', async () => {
  const h = harness(); h.rows[0].payload.analysis.en[0].paragraphs[0] = 'Two original analyses.';
  h.rows[0].contentHash = crypto.createHash('sha256').update(JSON.stringify(h.rows[0].payload)).digest('hex');
  assert.equal(windowFor(await h.service.workerConfig()).ready, true);
  h.repository.upsertBatch = async () => ({ upsertedCount: 1 });
  const current = createEditorialService({ repository: h.repository, clock: () => new Date(`${day}T10:00:00Z`), importEnabled: () => true });
  assert.equal((await current.importBatch({ source: petit, editionDate: day, items: [h.rows[0].payload] })).imported, 1);
  delete h.rows[0].payload.analysis.en;
  h.rows[0].contentHash = crypto.createHash('sha256').update(JSON.stringify(h.rows[0].payload)).digest('hex');
  assert.equal(windowFor(await h.service.workerConfig()).ready, true);
});
test('Paris midnight always queries the new edition and rejects stale rows', async () => {
  const h = harness(undefined, undefined, `${day}T22:00:00Z`), c = await h.service.workerConfig();
  assert.equal(c.date, '2026-10-25'); assert.equal(h.calls[0][1], '2026-10-25');
  assert.equal(c.publishedSourceWindows.sources.every(w => !w.ready), true);
});
test('repository inventory is a bounded projection and readonly query in mono-app database', async () => {
  const seen = {};
  const chain = { select(value) { seen.select = value; return this; }, limit(value) { seen.limit = value; return this; }, lean: async () => [] };
  const repository = createEditorialRepository({ Category: {}, EditorialItem: { find(query) { seen.query = query; return chain; } } });
  assert.deepEqual(await repository.sourceWindowItems(['cat'], day), []);
  assert.deepEqual(seen.query, { categoryId: { $in: ['cat'] }, editionDate: day, source: { $in: [petit, turf] } });
  assert.equal(seen.limit, 51); assert.match(seen.select, /payload contentHash isPublished/);
});
