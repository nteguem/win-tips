const test = require('node:test');
const assert = require('node:assert/strict');
const vectors = require('./fixtures/editorial-copy-v1.json').vectors;
const copy = require('../src/api/services/common/editorialCopy');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const clone = value => JSON.parse(JSON.stringify(value));
const crypto = require('node:crypto');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createEditorialNotificationService } = require('../src/api/services/common/editorialNotifications');
const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
function batch() {
  return { source: 'rdj_petit_journal', editionDate: '2026-10-25', items: [{ kind: 'match', sourceId: '101',
    sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/101-journal-du-25-octobre.html', title: { fr: 'Alpha - Bravo', en: 'Alpha - Bravo' },
    summary: { fr: 'Rencontre du jour.', en: 'Today\u2019s match.' }, startsAtUtc: '2026-10-25T16:00:00Z',
    sport: { key: 'football', name: 'Football' }, competition: { name: 'League' }, teams: { home: { name: 'Alpha' }, away: { name: 'Bravo' } },
    analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Alpha reste prudent.'] }], en: [{ heading: 'Context', paragraphs: ['Alpha remain cautious.'] }] },
    selection: { label: { fr: 'Victoire Alpha', en: 'Alpha to win' }, odds: 1.5 }, status: 'upcoming' }] };
}
const clock = () => new Date('2026-10-25T08:00:00Z');
test('eight shared Python protocol vectors have the exact same hash, rendering and envelope for all events', () => {
  assert.equal(vectors.length, 8);
  for (const { facts, copy: value } of vectors) {
    assert.deepEqual(copy.checkedFacts(facts), facts);
    assert.equal(copy.digest(facts), value.sourceHash);
    assert.deepEqual(copy.validateCopy(facts, value), value);
  }
});
test('optional batch copy binds normalized UTC, entire FR context and source IDs without modifying source items', () => {
  const input = batch(), original = clone(input);
  input.editorialCopy = copy.fallback(copy.factsFromBatch(input));
  const normalized = validateBatch(input, clock());
  assert.equal(require('../tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.from(JSON.stringify(input)), clock()).passed, true);
  assert.deepEqual(normalized.editorialCopy, input.editorialCopy);
  assert.deepEqual(input.items, original.items);
  assert.equal(normalized.items[0].editorialCopy, undefined);
  assert.equal(copy.factsFromBatch(normalized).items[0].startsAtUtc, '2026-10-25T16:00:00.000Z');
  const changed = clone(input); changed.items[0].analysis.fr[0].paragraphs.push('Autre contexte.');
  assert.throws(() => validateBatch(changed, clock()), { errorCode: 'EDITORIAL_COPY_INVALID' });
  const omitted = clone(input); delete omitted.editorialCopy;
  assert.equal(validateBatch(omitted, clock()).editorialCopy, undefined);
});
test('arbitrary prose, wrong body language, extra keys, unknown angle or focus and stale order/hash fail closed', () => {
  const { facts, copy: original } = vectors[0];
  const mutations = [v => v.body.fr += ' Victoire garantie.', v => v.body.en = v.body.fr, v => v.body.extra = 'x',
    v => v.choice.angle = 'prediction', v => v.choice.focusIds = ['missing'], v => v.choice.focusIds.push('102'), v => v.choice.focusIds = ['101'],
    v => v.sourceIds.reverse(), v => v.sourceHash = '0'.repeat(64), v => v.method = 'local',
    v => v.model = 'private backend', v => v.cacheKey = null, v => v.nativeSha256 = 'f'.repeat(63), v => v.reason = 'x'];
  for (const mutate of mutations) { const value = clone(original); mutate(value); assert.throws(() => copy.validateCopy(facts, value)); }
});
test('fallback must be exact for all focuses, metadata null and complete labels only for long names', () => {
  const facts = vectors[0].facts, value = copy.fallback(facts);
  assert.deepEqual(copy.validateCopy(facts, value), value);
  const altered = clone(value); altered.choice.focusIds = ['102'];
  assert.throws(() => copy.validateCopy(facts, altered));
  for (const key of ['model', 'nativeSha256', 'cacheKey']) { const x = clone(value); x[key] = 'a'.repeat(64); assert.throws(() => copy.validateCopy(facts, x)); }
  const labels = vectors.find(vector => vector.copy.choice.angle === 'labels');
  assert.deepEqual(copy.fallback(labels.facts), labels.copy);
  const long = clone(facts); long.items = Array.from({ length: 6 }, (_, n) => ({ ...long.items[0], id: String(n), home: '\ud83d\ude00'.repeat(180) }));
  assert.throws(() => copy.fallback(copy.checkedFacts(long)));
});
test('copy hashes bind all analysis sections and combine first leg while keeping parent identity', () => {
  const input = batch(), event = input.items[0];
  event.analysis.fr.push({ paragraphs: ['Second paragraphe.', 'Troisieme paragraphe.'] });
  input.items = [{ kind: 'combine', sourceId: 'parent', legs: [event, { ...event, sourceId: 'other' }] }];
  const facts = copy.factsFromBatch(input);
  assert.equal(facts.items[0].id, 'parent'); assert.equal(facts.items[0].contextFr, 'Alpha reste prudent.\n\nSecond paragraphe.\n\nTroisieme paragraphe.');
  assert.equal(facts.items.length, 1);
});
test('snapshot records only copy/hash and an order-sensitive item identity hash', () => {
  const group = { editorialCopy: vectors[0].copy, items: [{ _id: 'row-a', sourceId: '101', payload: { title: 'A' } }, { _id: 'row-b', sourceId: '102', payload: { title: 'B' } }] };
  const snapshot = copy.notificationSnapshot(group);
  assert.equal(snapshot.editorialCopySha256, copy.digest(vectors[0].copy));
  assert.notEqual(snapshot.itemHash, copy.notificationSnapshot({ ...group, items: [...group.items].reverse() }).itemHash);
  assert.deepEqual(Object.keys(snapshot).sort(), ['editorialCopy', 'editorialCopySha256', 'itemHash']);
});
function publishedFixture() {
  const normalized = validateBatch(batch(), clock()), value = copy.fallback(copy.factsFromBatch(normalized));
  const payload = normalized.items[0], contentHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const row = { _id: 'b'.repeat(24), categoryId: 'a'.repeat(24), source: normalized.source, editionDate: normalized.editionDate,
    sourceId: payload.sourceId, payload, contentHash, isPublished: true };
  const record = { _id: 'wintips:' + normalized.source + ':' + normalized.editionDate, appId: 'wintips', source: normalized.source, editionDate: normalized.editionDate, initialized: true, legacy: false,
    copy: value, copySha256: copy.digest(value), itemHashes: [{ sourceId: row.sourceId, contentHash }] };
  return { normalized, row, record, value };
}
test('feed exposes the localized copy in the description read by existing phones without changing stored BO or source text', async () => {
  const { row, record, value } = publishedFixture(), original = clone(row.payload);
  const category = { _id: row.categoryId, isActive: true, isVip: false, editorialSource: row.source,
    name: { fr: 'Rubrique', en: 'Category' }, description: { fr: 'Texte BO', en: 'BO text' } };
  const originalCategory = clone(category);
  const repository = { categories: async () => [category], items: async () => [row], copies: async () => [record],
    hasAnySubscription: async () => false, gate: async () => ({ locked: false, gated: false }) };
  const service = createEditorialService({ repository, clock });
  for (const language of ['fr', 'en']) {
    const out = (await service.feed({ lang: language })).categories[0];
    assert.equal(typeof out.description, 'string');
    assert.equal(out.description, value.body[language]); assert.equal(out.editorialDescription, out.description);
    assert.notEqual(out.description, category.description[language]);
    assert.equal(out.name, category.name[language]);
    assert.deepEqual(out.items[0].summary, original.summary);
  }
  assert.deepEqual(row.payload, original);
  assert.deepEqual(category, originalCategory);
});

test('feed keeps one short public match label when the daily copy is absent, legacy or no longer bound', async () => {
  for (const scenario of ['absent', 'legacy', 'tampered', 'changed-payload']) {
    const { row, record } = publishedFixture();
    const category = { _id: row.categoryId, isActive: true, isVip: false, editorialSource: row.source,
      name: { fr: 'Rubrique', en: 'Category' }, description: { fr: 'Texte BO', en: 'BO text' } };
    if (scenario === 'legacy') record.legacy = true;
    if (scenario === 'tampered') record.copy.body.en += ' Unreviewed copy.';
    if (scenario === 'changed-payload') row.payload.analysis.fr[0].paragraphs.push('Nouveau contexte.');
    const originalCategory = clone(category), originalPayload = clone(row.payload), originalRecord = clone(record);
    const repository = { categories: async () => [category], items: async () => [row],
      copies: async () => scenario === 'absent' ? [] : [record],
      hasAnySubscription: async () => false, gate: async () => ({ locked: false, gated: false }) };
    const service = createEditorialService({ repository, clock });
    for (const language of ['fr', 'en']) {
      const out = (await service.feed({ lang: language })).categories[0];
      assert.equal(out.description, 'Alpha \u2014 Bravo', scenario + ':' + language);
      assert.equal(out.editorialDescription, out.description, scenario + ':' + language);
      assert.ok([...out.description].length <= 140);
      assert.deepEqual(out.items[0].summary, originalPayload.summary);
    }
    assert.deepEqual(category, originalCategory);
    assert.deepEqual(row.payload, originalPayload);
    assert.deepEqual(record, originalRecord);
  }
});
test('copy reads fail closed on changed payload/hash, partial/duplicate identities, wrong date or tampered copy', () => {
  const { row, record, value } = publishedFixture(); assert.deepEqual(copy.boundCopy(record, [row]), value);
  const mutations = [r => r.payload.analysis.fr[0].paragraphs.push('Nouveau texte.'), r => r.contentHash = 'bad',
    r => r.isPublished = false, r => r.sourceId = 'other', r => r.editionDate = '2026-10-24'];
  for (const mutate of mutations) { const changed = clone(row); mutate(changed); assert.equal(copy.boundCopy(record, [changed]), null); }
  assert.equal(copy.boundCopy(record, []), null); assert.equal(copy.boundCopy(record, [row, row]), null);
  const changed = clone(record); changed.copy.body.fr += ' Surprise.'; assert.equal(copy.boundCopy(changed, [row]), null);
  for (const key of ['appId', '_id']) { const wrong = clone(record); wrong[key] = 'other'; assert.equal(copy.boundCopy(wrong, [row]), null); }
});
test('copy-only index provisioning defaults to inspection and never touches historical collections', async () => {
  const { provision } = require('../tools/editorial-indexes.cjs'); let current = [], calls = [];
  const db = { collection: name => { assert.equal(name, 'editorialcopies'); return {
    listIndexes: () => ({ toArray: async () => current }), createIndex: async (key, options) => { calls.push('index'); current.push({ key, ...options }); },
  }; }, createCollection: async name => { assert.equal(name, 'editorialcopies'); calls.push('collection'); } };
  const check = await provision(db, { onlyCopies: true }); assert.equal(check.ready, false); assert.deepEqual(calls, []);
  await assert.rejects(provision(db, { onlyCopies: true, apply: true }), { code: 'INTENT_REQUIRED' });
  assert.equal((await provision(db, { onlyCopies: true, apply: true, intent: true })).ready, true); assert.deepEqual(calls, ['collection', 'index']);
  assert.equal((await provision(db, { onlyCopies: true, apply: true, intent: true })).readOnly, true); assert.equal(calls.length, 2);
});
test('ledger claim freezes copy/hash/itemHash only in setOnInsert, never into subsequent processing updates', async () => {
  const { value, row } = publishedFixture(), snapshot = copy.notificationSnapshot({ items: [row], editorialCopy: value });
  const writes = [], repository = createEditorialNotificationRepository({ EditorialNotification: {
    updateOne: async (...args) => writes.push(args), findOneAndUpdate: (filter, update) => { writes.push([filter, update]); return { lean: async () => ({ ...snapshot }) }; },
  } });
  const key = { appId: 'wintips', categoryId: row.categoryId, source: row.source, editionDate: row.editionDate };
  await repository.claim(key, 'notification', clock(), snapshot);
  assert.deepEqual(writes[0][1].$setOnInsert.editorialCopy, value); assert.equal(writes[0][1].$setOnInsert.itemHash, snapshot.itemHash);
  assert.equal(writes[1][1].$set.editorialCopy, undefined); assert.equal(writes[1][1].$set.itemHash, undefined);
});
function drainFixture({ legacy = false, change = false, staleHash = false } = {}) {
  const { value, row } = publishedFixture(); const category = { _id: row.categoryId, isVip: false };
  const group = { category, source: row.source, editionDate: row.editionDate, items: [row], editorialCopy: value };
  const snapshot = copy.notificationSnapshot(group);
  const state = { calls: [], ledger: legacy ? {} : { ...snapshot }, status: null };
  if (staleHash) { row.payload.teams.home.name = 'Changed name'; group.editorialCopy = null; }
  if (change) state.ledger.itemHash = 'f'.repeat(64);
  const repository = { groups: async () => [group], assertIndexes: async () => {},
    claim: async () => ({ ...state.ledger, lockToken: 'lock', passes: 1 }),
    categoryStillMatches: async () => true, deviceBatch: async after => after ? [] : [{ _id: 'device', deviceId: 'device', language: 'en', editorialSchemaVersion: 1 }],
    checkpoint: async () => {}, deliverySummary: async () => ({ accepted: 1 }), finish: async (key, token, fields) => { state.status = fields.status; },
  };
  const service = createEditorialNotificationService({ repository, clock, enabled: () => true, importEnabled: () => true,
    push: async (app, notification) => { state.calls.push(notification); return { fcm: 1 }; } });
  return { service, state, value };
}
test('new notification uses the frozen bilingual copy and unchanged stable delivery ID; legacy claims stay generic', async () => {
  let h = drainFixture(); await h.service.drain({ dryRun: false }); assert.equal(h.state.calls[0].body, h.value.body.en);
  assert.equal(h.state.calls[0].extra.action, 'view_editorial');
  h = drainFixture({ legacy: true }); await h.service.drain({ dryRun: false }); assert.match(h.state.calls[0].body, /^Analysis and statistics:/);
  assert.equal(h.state.status, 'completed');
});
test('changed item snapshot requires review before any push and never overwrites the old claim', async () => {
  const h = drainFixture({ change: true }), previous = clone(h.state.ledger);
  const report = await h.service.drain({ dryRun: false }); assert.equal(report.sent, 0); assert.equal(report.pending, 0);
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.status, 'review_required'); assert.deepEqual(h.state.ledger, previous);
});
test('stale stored content hash cannot hide changed payload or reuse a previously claimed copy', async () => {
  const h = drainFixture({ staleHash: true }), before = clone(h.state.ledger);
  const result = await h.service.drain({ dryRun: false });
  assert.equal(result.groups[0].status, 'review_required'); assert.equal(h.state.calls.length, 0);
  assert.deepEqual(h.state.ledger, before);
});
test('worker config exposes only current copy state, not body, context, hashes or native provenance', async () => {
  const { row, record } = publishedFixture(); let requested;
  const repository = { categories: async () => [{ _id: row.categoryId, isActive: true, isVip: false, editorialSource: row.source }],
    copyStates: async (sources, date) => { requested = date; return [{ source: row.source, state: 'frozen', legacy: true, copy: record.copy }]; } };
  const config = await createEditorialService({ repository, clock }).workerConfig();
  assert.equal(requested, '2026-10-25'); assert.deepEqual(config.sources[0].editorialCopyState, { state: 'frozen', legacy: true });
  assert.equal(JSON.stringify(config).includes(record.copy.sourceHash), false); assert.equal(JSON.stringify(config).includes(record.copy.body.fr), false);
});
test('copy-state lookup is read-only and degrades to unknown when storage is unavailable', async () => {
  const { createCopyStorage } = require('../src/api/services/common/editorialCopyStorage'); let reads = 0;
  const storage = createCopyStorage({ db: { db: { collection: () => ({ listIndexes: () => ({ toArray: async () => { reads++; throw new Error('synthetic unavailable'); } }) }) } } });
  assert.deepEqual(await storage.states(['rdj_petit_journal'], '2026-10-25'), [{ source: 'rdj_petit_journal', state: 'unknown', legacy: false }]);
  assert.equal(reads, 1);
});
