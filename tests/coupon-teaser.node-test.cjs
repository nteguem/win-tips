'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('crypto');
const { VERSION, sortedFacts, teaserFactsFromBatch, validateTeaser, boundTeaser, teaserForOperations } = require('../src/api/services/common/couponTeaser');
const { factsFromBatch, digest, fallback } = require('../src/api/services/common/editorialCopy');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createCopyStorage, INDEX } = require('../src/api/services/common/editorialCopyStorage');
const clone = value => JSON.parse(JSON.stringify(value));
const source = 'rdj_petit_journal', day = '2026-10-25', categoryId = 'a'.repeat(24);
const clock = () => new Date(day + 'T08:00:00Z');
function fixture(count = 10) {
  const input = { source, editionDate: day, items: Array.from({ length: count }, (_, index) => ({
    kind: 'match', sourceId: String(101 + index),
    sourceUrl: `https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/${101 + index}-journal-du-25-octobre.html`,
    title: { fr: `Club ${index} - Rival ${index}`, en: `Club ${index} - Rival ${index}` },
    summary: { fr: 'Le club reste sur 4 victoires.', en: 'The club have recorded 4 wins.' },
    startsAtUtc: day + 'T16:00:00Z', sport: { key: 'football', name: 'Football' }, competition: { name: 'League' },
    teams: { home: { name: `Club ${index}` }, away: { name: `Rival ${index}` } },
    analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Le club reste sur 4 victoires.'] }], en: [{ heading: 'Context', paragraphs: ['The club have recorded 4 wins.'] }] },
    selection: { label: { fr: 'Victoire du club', en: 'Club to win' }, odds: 1.5 }, status: 'upcoming',
  })) };
  const batch = validateBatch(input, clock()), facts = factsFromBatch(batch);
  const teaser = { version: VERSION, sourceHash: digest(sortedFacts(facts)), body: {
    fr: 'Une dynamique de 4 victoires au coeur des affiches de cette edition.',
    en: 'A run of 4 wins sets the scene for this edition.',
  } };
  const rows = batch.items.map((payload, index) => ({ _id: String(index).padStart(24, '0'), source, editionDate: day,
    sourceId: payload.sourceId, categoryId, payload, isPublished: true,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
  const copy = fallback(facts);
  const record = { _id: `wintips:${source}:${day}`, appId: 'wintips', source, editionDate: day, initialized: true, legacy: false,
    copy, copySha256: digest(copy), itemHashes: rows.map(row => ({ sourceId: row.sourceId, contentHash: row.contentHash })), couponTeaser: teaser };
  const category = { _id: categoryId, isActive: true, isVip: false, editorialSource: source, name: { fr: 'Journal', en: 'Journal' } };
  const repository = { categories: async () => [category], category: async () => category,
    items: async () => rows, copies: async () => [record], reviewSummaries: async () => [], availableDates: async () => [day],
    hasAnySubscription: async () => false, gate: async () => ({ locked: false, gated: false }) };
  return { input, batch, facts, teaser, rows, record, repository };
}
test('one generated coupon sentence is read verbatim in both languages with ten full matches retained', async () => {
  const h = fixture(), before = clone({ rows: h.rows, record: h.record });
  const service = createEditorialService({ repository: h.repository, clock });
  for (const lang of ['fr', 'en']) {
    for (const card of [(await service.library({ lang })).categories[0], await service.edition(categoryId, day, { lang }),
      (await service.feed({ lang })).categories[0]]) {
      assert.equal(card.description, h.teaser.body[lang]);
      assert.equal(card.editorialDescription, h.teaser.body[lang]);
      assert.ok([...card.description].length <= 100);
      assert.doesNotMatch(card.description, /Club 0|Rival 0|\u2026|\.\.\./);
    }
    const reader = await service.content(categoryId, day, { lang });
    assert.equal(reader.items.length, 10);
    reader.items.forEach((item, index) => assert.deepEqual(item.analysis, h.rows[index].payload.analysis));
  }
  assert.deepEqual({ rows: h.rows, record: h.record }, before);
});
test('teaser hashes bind the complete facts but are independent of source/Mongo event order', () => {
  const h = fixture();
  assert.deepEqual(validateTeaser({ ...h.facts, items: [...h.facts.items].reverse() }, h.teaser), h.teaser);
  assert.deepEqual(boundTeaser(h.record, [...h.rows].reverse()), h.teaser);
  const changed = clone(h.rows); changed[9].payload.analysis.fr[0].paragraphs.push('A new source fact.');
  changed[9].contentHash = crypto.createHash('sha256').update(JSON.stringify(changed[9].payload)).digest('hex');
  assert.equal(boundTeaser(h.record, changed), null);
  assert.equal(boundTeaser(h.record, h.rows.slice(1)), null);
  assert.equal(boundTeaser({ ...h.record, appId: 'another-app' }, h.rows), null);
});
test('a bad optional teaser never blocks the valid sports batch or alters source content', () => {
  const h = fixture(1);
  const invalid = [null, {}, { ...h.teaser, sourceHash: 'f'.repeat(64) }, { ...h.teaser, extra: true },
    { ...h.teaser, body: { fr: 'x'.repeat(101), en: 'English.' } },
    { ...h.teaser, body: { fr: 'A truncated sentence\u2026', en: 'English.' } },
    { ...h.teaser, body: { fr: '<b>HTML</b>', en: 'English.' } },
    { ...h.teaser, body: { fr: 'Notre choix : victoire du club.', en: 'Our pick: club to win.' } },
    { ...h.teaser, body: { fr: 'Deux phrases. C est trop.', en: 'Two sentences. Not one.' } },
    { ...h.teaser, body: { fr: 'Une phrase sans ponctuation', en: 'Missing punctuation' } },
    { ...h.teaser, body: { fr: '**Un titre**.', en: '**A title**.' } }];
  for (const couponTeaser of invalid) {
    const result = validateBatch({ ...clone(h.input), couponTeaser }, clock());
    assert.equal(result.couponTeaser, undefined);
    assert.deepEqual(result.items, h.batch.items);
  }
  const result = validateBatch({ ...clone(h.input), couponTeaser: h.teaser }, clock());
  assert.deepEqual(result.couponTeaser, h.teaser);
  assert.deepEqual(result.items, h.batch.items);
});
test('the dedicated teaser facts include every combined leg without changing the historical V2 facts', () => {
  const h = fixture(3), combined = { ...h.batch, items: [{ sourceId: 'parent-ticket', kind: 'combine', legs: h.batch.items }] };
  const before = clone(combined), facts = teaserFactsFromBatch(combined);
  assert.equal(facts.items.length, 3);
  for (const leg of h.batch.items) assert.ok(facts.items.some(item => item.id === 'leg-' + digest(['parent-ticket', leg.sourceId])));
  const oldHash = digest(factsFromBatch(combined)), newHash = digest(facts);
  combined.items[0].legs[2].analysis.fr[0].paragraphs.push('Another context on the third leg.');
  assert.equal(digest(factsFromBatch(combined)), oldHash, 'V2 first-leg protocol remains unchanged');
  assert.notEqual(digest(teaserFactsFromBatch(combined)), newHash);
  assert.deepEqual(before.items[0].legs[1], combined.items[0].legs[1]);
});
test('import passes the separate teaser to storage without modifying source hashes or frozen notification copy', async () => {
  const h = fixture(1), written = [];
  const service = createEditorialService({ repository: { ...h.repository,
    upsertBatch: async (operations, context) => { written.push({ operations, context }); return {}; },
  }, clock, importEnabled: () => true });
  await service.importBatch({ ...clone(h.input), couponTeaser: h.teaser });
  await service.importBatch(clone(h.input));
  assert.deepEqual(written[0].operations, written[1].operations);
  assert.deepEqual(written[0].context.couponTeaser, h.teaser);
  assert.equal(written[1].context.couponTeaser, undefined);
  assert.equal(written[0].context.editorialCopy, null);
});
test('a published frozen copy accepts only the separate caption field and is not reworded on retries', async () => {
  const h = fixture(1), record = clone(h.record), writes = [];
  delete record.couponTeaser; record.revision = 1;
  const frozen = clone({ copy: record.copy, copySha256: record.copySha256, itemHashes: record.itemHashes });
  const operations = h.rows.map(row => ({ updateOne: { filter: { source, editionDate: day, sourceId: row.sourceId },
    update: { $set: { payload: row.payload, contentHash: row.contentHash } } } }));
  const collection = { findOne: async () => record, updateOne: async (filter, update) => {
    writes.push(clone(update)); if (update.$inc) record.revision += update.$inc.revision;
    if (update.$set) Object.assign(record, clone(update.$set)); return { matchedCount: 1 };
  } };
  const storage = createCopyStorage({ db: { db: { collection: () => collection } } });
  const context = { source, editionDate: day, couponTeaser: h.teaser };
  await storage.lockAndInitialize(context, operations, {});
  await storage.lockAndInitialize(context, operations, {});
  assert.equal(writes.filter(update => update.$set).length, 1);
  assert.deepEqual(writes.find(update => update.$set), { $set: { couponTeaser: h.teaser } });
  assert.deepEqual({ copy: record.copy, copySha256: record.copySha256, itemHashes: record.itemHashes }, frozen);
  assert.deepEqual(boundTeaser(record, h.rows), h.teaser);
  assert.equal(teaserForOperations({ ...context, couponTeaser: {} }, operations), null);
  record.couponTeaser.body.fr = 'x'.repeat(101);
  await storage.lockAndInitialize(context, operations, {});
  assert.deepEqual(record.couponTeaser, h.teaser, 'a malformed caption with the same source hash can be repaired');
  assert.deepEqual({ copy: record.copy, copySha256: record.copySha256, itemHashes: record.itemHashes }, frozen);
});
test('worker readiness is read only, bound to current source facts, and degrades safely when unavailable', async () => {
  const h = fixture(1);
  const itemCollection = { find: () => ({ limit: () => ({ toArray: async () => h.rows }) }) };
  const copies = { listIndexes: () => ({ toArray: async () => [INDEX] }), find: () => ({ toArray: async () => [h.record] }) };
  const storage = createCopyStorage({ collection: itemCollection, db: { db: { collection: () => copies } } });
  assert.deepEqual(await storage.teaserStates([source, 'rdj_turf_quinte'], day), [{ source, state: 'ready' }, { source: 'rdj_turf_quinte', state: 'missing' }]);
  h.rows[0].payload.analysis.fr[0].paragraphs.push('Source changed.');
  assert.deepEqual(await storage.teaserStates([source], day), [{ source, state: 'missing' }]);
  copies.listIndexes = () => { throw Error('unavailable'); };
  assert.deepEqual(await storage.teaserStates([source], day), [{ source, state: 'unknown' }]);
});
test('worker config exposes caption readiness without exposing the body or changing frozen copy status', async () => {
  const h = fixture(1);
  h.repository.copyStates = async () => [{ source, state: 'frozen', legacy: false }];
  h.repository.teaserStates = async () => [{ source, state: 'missing' }];
  const config = await createEditorialService({ repository: h.repository, clock }).workerConfig();
  assert.equal(config.sources[0].couponTeaserState, 'missing');
  assert.deepEqual(config.sources[0].editorialCopyState, { state: 'frozen', legacy: false });
  assert.equal(JSON.stringify(config).includes(h.teaser.body.fr), false);
});
