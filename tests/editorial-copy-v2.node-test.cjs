const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const copy = require('../src/api/services/common/editorialCopy');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const { contextualDescription } = require('../src/api/services/common/editorialTeaser');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { createEditorialNotificationService } = require('../src/api/services/common/editorialNotifications');
const clone = value => JSON.parse(JSON.stringify(value));
const clock = () => new Date('2026-10-25T08:00:00Z');
const categoryId = 'a'.repeat(24);
const vectors = require('./fixtures/editorial-copy-v2.json').vectors;
const contexts = [
  ['Marseille', 'Le Havre', 'Marseille reste sur 4 victoires.', 'Marseille have recorded 4 wins.',
    'Marseille peut-il prolonger sa dynamique au Velodrome ?', 'Can Marseille maintain their momentum at the Velodrome?',
    'La serie marseillaise continue ?', 'Can Marseille keep their run going?'],
  ['Inter', 'Fiorentina', "L'Inter a ete intraitable sur la scene nationale l'an passe.", 'Inter were dominant domestically last season.',
    "Le champion retrouve son public : quels reperes pour l'Inter ?", 'The champions return home: what shape are Inter in?',
    "Quels reperes pour l'Inter ?", 'What shape are Inter in?'],
  ['Monaco', 'Lille', "Monaco connait un coup d'arret en Championnat.", 'Monaco are experiencing a halt in momentum in the Championship.',
    "Monaco traverse un coup d'arret : comment aborder ce rendez-vous ?", 'Monaco face a halt in momentum: how do they approach this meeting?',
    'Monaco peut-il retrouver son elan ?', 'Can Monaco regain their momentum?'],
];
function inputBatch() {
  return { source: 'rdj_petit_journal', editionDate: '2026-10-25', items: contexts.map(([home, away, fr, en], index) => ({
    kind: 'match', sourceId: String(101 + index),
    sourceUrl: `https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/${101 + index}-journal-du-25-octobre.html`,
    title: { fr: `${home} - ${away}`, en: `${home} - ${away}` }, summary: { fr, en },
    startsAtUtc: '2026-10-25T16:00:00Z', sport: { key: 'football', name: 'Football' }, competition: { name: 'League' },
    teams: { home: { name: home }, away: { name: away } },
    analysis: { fr: [{ heading: 'Contexte', paragraphs: [fr] }], en: [{ heading: 'Context', paragraphs: [en] }] },
    selection: { label: { fr: `Victoire ${home}`, en: `${home} to win` }, odds: 1.5 }, status: 'upcoming',
  })) };
}
function v2Copy(facts) {
  const sourceIds = facts.items.map(row => row.id);
  const choice = { angle: 'context', focusIds: sourceIds, entries: facts.items.map((row, index) => ({ id: row.id,
    description: { fr: contexts[index % contexts.length][4], en: contexts[index % contexts.length][5] },
    notification: { fr: contexts[index % contexts.length][6], en: contexts[index % contexts.length][7] },
  })) };
  return { version: copy.V2_VERSION, sourceHash: copy.digest(facts), sourceIds, choice,
    body: copy.renderV2(facts, choice), notificationBody: copy.renderV2(facts, choice, 'notification'),
    method: 'gemini', model: 'gemini-3.5-flash-lite', cacheKey: '1'.repeat(64), nativeSha256: '2'.repeat(64) };
}
function publishedFixture() {
  const batch = validateBatch(inputBatch(), clock()), facts = copy.factsFromBatch(batch), value = v2Copy(facts);
  const rows = batch.items.map((payload, index) => ({ _id: String(index + 1).padStart(24, '0'), categoryId,
    source: batch.source, editionDate: batch.editionDate, sourceId: payload.sourceId, payload, isPublished: true,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
  const record = { _id: `wintips:${batch.source}:${batch.editionDate}`, appId: 'wintips', source: batch.source, editionDate: batch.editionDate,
    initialized: true, legacy: false, copy: value, copySha256: copy.digest(value),
    itemHashes: rows.map(row => ({ sourceId: row.sourceId, contentHash: row.contentHash })) };
  const category = { _id: categoryId, isActive: true, isVip: false, editorialSource: batch.source,
    name: { fr: 'Rubrique', en: 'Category' }, description: { fr: 'Texte BO', en: 'BO text' } };
  const repository = { categories: async () => [category], category: async () => category,
    items: async () => rows, copies: async () => [record], availableDates: async () => [batch.editionDate],
    reviewSummaries: async () => [], hasAnySubscription: async () => false, gate: async () => ({ locked: false, gated: false }) };
  return { batch, facts, value, rows, record, category, repository };
}

test('seven shared Python v2 vectors retain the exact factual hash, native hooks and compact bilingual bodies', () => {
  assert.equal(vectors.length, 7);
  for (const { facts, copy: value } of vectors) {
    assert.deepEqual(copy.checkedFacts(facts), facts);
    assert.equal(copy.digest(facts), value.sourceHash);
    assert.deepEqual(copy.validateCopy(facts, value), value);
    for (const language of ['fr', 'en']) {
      assert.equal(copy.renderV2(facts, value.choice)[language], value.body[language]);
      assert.equal(copy.renderV2(facts, value.choice, 'notification')[language], value.notificationBody[language]);
      assert.ok(Buffer.byteLength(value.body[language], 'utf8') <= 1800);
      assert.ok(Buffer.byteLength(value.notificationBody[language], 'utf8') <= 900);
      assert.equal(value.body[language].includes('\ufffd'), false);
      assert.equal(value.notificationBody[language].includes('\ufffd'), false);
    }
    assert.equal(value.choice.entries.length, facts.items.length);
    assert.deepEqual(value.choice.focusIds, facts.items.map(row => row.id));
    if (value.method === 'source_excerpt_fallback') {
      for (const entry of value.choice.entries) {
        assert.match(entry.description.en, /^Starts at \d{2}:\d{2} UTC on /);
        assert.match(entry.notification.en, /^Starts at \d{2}:\d{2} UTC on /);
      }
    }
  }
  const many = vectors.find(vector => vector.facts.items.length === 50);
  assert.ok(many.copy.notificationBody.en.includes(' more events'));
  assert.ok(many.copy.body.fr.includes(' autres rencontres'));
  const clipped = vectors.find(vector => vector.copy.notificationBody.en.includes('…'));
  assert.ok(clipped);
  assert.ok(clipped.copy.notificationBody.en.includes('…'));
});

test('v2 carries distinct context and short notification for every fixture in both languages', () => {
  const { batch, facts, value } = publishedFixture(), before = clone(batch.items);
  assert.deepEqual(copy.validateCopy(facts, value), value);
  assert.deepEqual(value.choice.focusIds, ['101', '102', '103']);
  for (const language of ['fr', 'en']) {
    assert.equal(new Set(value.choice.entries.map(entry => entry.description[language])).size, 3);
    assert.equal(new Set(value.choice.entries.map(entry => entry.notification[language])).size, 3);
    assert.notEqual(value.body[language], value.notificationBody[language]);
    for (const [index, item] of batch.items.entries()) {
      assert.ok(value.body[language].includes(`${item.teams.home.name} — ${item.teams.away.name}`));
      assert.ok(value.notificationBody[language].includes(value.choice.entries[index].notification[language]));
    }
  }
  assert.deepEqual(batch.items, before);
});

test('v2 bindings reject a changed hash, incomplete/reordered/duplicate events, unsafe text or forged rendered body', () => {
  const { facts, value } = publishedFixture();
  const mutations = [v => v.sourceHash = '0'.repeat(64), v => v.sourceIds.reverse(), v => v.choice.focusIds.pop(),
    v => v.choice.entries.reverse(), v => v.choice.entries[1].id = v.choice.entries[0].id,
    v => v.choice.entries[0].description.fr = '<b>Texte</b>', v => v.choice.entries[0].notification.en = 'x'.repeat(91),
    v => v.choice.entries[0].notification.fr = '\u202ehidden', v => v.body.fr += ' Surprise.',
    v => delete v.notificationBody, v => v.notificationBody.en = v.body.en, v => v.choice.angle = 'duel',
    v => v.method = 'deterministic_fallback', v => v.choice.entries[0].description.extra = 'x'];
  for (const mutate of mutations) { const changed = clone(value); mutate(changed); assert.throws(() => copy.validateCopy(facts, changed)); }
  const changedFacts = clone(facts); changedFacts.items[1].contextFr += ' Nouveau paragraphe.';
  assert.throws(() => copy.validateCopy(changedFacts, value));
});

test('short wording and source-excerpt fallback pass without a semantic or word-count quality gate', () => {
  const { facts, value } = publishedFixture();
  value.method = 'source_excerpt_fallback'; value.model = value.cacheKey = value.nativeSha256 = null;
  for (const entry of value.choice.entries) entry.description = entry.notification = { fr: 'Pourquoi ?', en: 'Why?' };
  value.body = copy.renderV2(facts, value.choice); value.notificationBody = copy.renderV2(facts, value.choice, 'notification');
  assert.deepEqual(copy.validateCopy(facts, value), value);
});

test('invalid optional v2 copy is omitted while valid source facts still import and pass the actual API preflight', async () => {
  const base = inputBatch(), value = v2Copy(copy.factsFromBatch(base));
  const mutations = [v => v.body.en = '<script>x</script>', v => v.choice.entries[0].description.fr = '',
    v => v.sourceHash = '0'.repeat(64), v => v.sourceIds.pop(), v => v.notificationBody = null];
  for (const mutate of mutations) {
    const input = clone(base); input.editorialCopy = clone(value); mutate(input.editorialCopy);
    const normalized = validateBatch(input, clock()); assert.equal(normalized.editorialCopy, undefined);
    assert.deepEqual(normalized.items, validateBatch(base, clock()).items);
    assert.equal(require('../tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.from(JSON.stringify(input)), clock()).passed, true);
    let written;
    const service = createEditorialService({ repository: {
      categories: async () => [{ _id: categoryId, isActive: true, isVip: false, editorialSource: base.source }],
      upsertBatch: async (operations, context) => { written = { operations, context }; return { upsertedCount: operations.length }; },
    }, clock, importEnabled: () => true });
    assert.equal((await service.importBatch(input)).imported, base.items.length);
    assert.equal(written.context.editorialCopy, null);
    assert.deepEqual(written.operations.map(operation => operation.updateOne.update.$set.payload), normalized.items);
    for (const operation of written.operations) {
      const { payload, contentHash } = operation.updateOne.update.$set;
      assert.equal(contentHash, crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
    }
    const badSource = clone(input); badSource.items[0].selection.odds = -1;
    await assert.rejects(service.importBatch(badSource), { statusCode: 400 });
  }
  const legacy = clone(base); legacy.editorialCopy = copy.fallback(copy.factsFromBatch(base)); legacy.editorialCopy.body.fr += ' Changed.';
  assert.throws(() => validateBatch(legacy, clock()), { errorCode: 'EDITORIAL_COPY_INVALID' });
});

test('bound v2 copy takes priority over available source excerpts in feed, library and native edition cards', async () => {
  const h = publishedFixture(), before = clone({ rows: h.rows, record: h.record, category: h.category });
  const service = createEditorialService({ repository: h.repository, clock });
  for (const lang of ['fr', 'en']) {
    const legacyExcerpt = contextualDescription(h.rows, lang); assert.ok(legacyExcerpt);
    assert.notEqual(legacyExcerpt, h.value.body[lang]);
    for (const card of [(await service.feed({ lang })).categories[0], (await service.library({ lang })).categories[0],
      await service.edition(categoryId, h.batch.editionDate, { lang })]) {
      assert.equal(card.description, h.value.body[lang]); assert.equal(card.editorialDescription, h.value.body[lang]);
    }
  }
  assert.deepEqual({ rows: h.rows, record: h.record, category: h.category }, before);
  h.record.copy = copy.fallback(h.facts); h.record.copySha256 = copy.digest(h.record.copy);
  const archived = clone(h.record);
  assert.equal((await service.library()).categories[0].description, contextualDescription(h.rows, 'fr'));
  assert.equal((await service.edition(categoryId, h.batch.editionDate)).description, contextualDescription(h.rows, 'fr'));
  assert.deepEqual(h.record, archived);
});

test('changed, partial or tampered v2 binding falls back to the existing source excerpt without rewriting the record', async () => {
  for (const scenario of ['content', 'partial', 'tampered', 'legacy']) {
    const h = publishedFixture();
    if (scenario === 'content') h.rows[0].payload.analysis.fr[0].paragraphs.push('Nouveau contexte.');
    if (scenario === 'partial') h.rows.pop();
    if (scenario === 'tampered') h.record.copy.notificationBody.fr += ' Changed.';
    if (scenario === 'legacy') h.record.legacy = true;
    const before = clone(h.record);
    assert.equal(copy.boundCopy(h.record, h.rows), null);
    assert.equal((await createEditorialService({ repository: h.repository, clock }).library()).categories[0].description,
      contextualDescription(h.rows, 'fr'));
    assert.deepEqual(h.record, before);
  }
});

test('v1 archives and v2 notification snapshots retain their original text and delivery ID across retries, then stop sending', async () => {
  for (const archivedV1 of [false, true]) {
    const h = publishedFixture();
    const group = { category: h.category, source: h.batch.source, editionDate: h.batch.editionDate, items: h.rows,
      editorialCopy: archivedV1 ? copy.fallback(h.facts) : h.value };
    const original = clone(group.editorialCopy), calls = [];
    let ledger, status, firstAttempt = true;
    const repository = { groups: async () => [group], assertIndexes: async () => {},
      claim: async (key, id, now, snapshot) => {
        if (status === 'completed') return null;
        if (!ledger) ledger = { ...clone(snapshot), lockToken: 'lock', passes: 1 };
        return clone(ledger);
      }, ledgerState: async () => ({ status }), categoryStillMatches: async () => true,
      deviceBatch: async after => after ? [] : [{ _id: 'device', deviceId: 'device', language: 'en', editorialSchemaVersion: 1 }],
      checkpoint: async () => {}, deliverySummary: async () => ({ accepted: 1 }),
      finish: async (key, token, fields) => { status = fields.status; },
    };
    const service = createEditorialNotificationService({ repository, clock, enabled: () => true, importEnabled: () => true,
      push: async (app, notification) => { calls.push(notification); if (firstAttempt) { firstAttempt = false; throw new Error('temporary'); } return { fcm: 1 }; } });
    await service.drain({ dryRun: false }); assert.equal(status, 'pending'); const frozen = clone(ledger);
    group.editorialCopy = v2Copy(h.facts);
    group.editorialCopy.choice.entries[0].notification.en = 'A later hook.';
    group.editorialCopy.notificationBody = copy.renderV2(h.facts, group.editorialCopy.choice, 'notification');
    await service.drain({ dryRun: false }); assert.equal(status, 'completed');
    const expected = (original.notificationBody || original.body).en;
    assert.equal(calls[0].body, expected); assert.equal(calls[1].body, expected); assert.equal(calls[0].id, calls[1].id);
    assert.deepEqual(ledger, frozen);
    await service.drain({ dryRun: false }); assert.equal(calls.length, 2); assert.equal(status, 'completed');
  }
});
