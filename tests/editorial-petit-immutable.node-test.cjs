// Pure DAL transaction simulation: real service/repository/copy lock, no Mongo,
// network, notification provider or application bootstrap.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { INDEX, PETIT_PUBLISHED } = require('../src/api/services/common/editorialCopyStorage');
const clone = value => structuredClone(value);
const source = 'rdj_petit_journal', day = '2026-11-10', categoryId = 'a'.repeat(24);
function payload(odds = 1.4) {
  return { source, sourceId: '6578489', editionDate: day, kind: 'match',
    sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74975-le-petit-journal-du-parieur-mardi-10-novembre-2026.html',
    title: { fr: 'Arthur Rinderknech contre Miomir Kecmanovic', en: 'Arthur Rinderknech versus Miomir Kecmanovic' },
    summary: { fr: 'Analyse du match.', en: 'Match analysis.' },
    startsAtUtc: day + 'T14:35:00Z', status: 'upcoming', sport: { key: 'tennis', name: 'Tennis' },
    competition: { name: 'ATP Stockholm' },
    teams: { home: { name: 'Arthur Rinderknech' }, away: { name: 'Miomir Kecmanovic' } },
    analysis: { fr: [{ heading: 'Le contexte', paragraphs: ['Analyse originale.'] }],
      en: [{ heading: 'Context', paragraphs: ['Original analysis.'] }] },
    selection: { label: { fr: 'Victoire Rinderknech', en: 'Rinderknech to win' }, odds } };
}
function harness() {
  let data = { editorialcopies: [], editorialnotifications: [], items: [] }, tail = Promise.resolve();
  let writes = 0, notifications = 0, failNextWrite = false, nextWriteError = null, lockConflict = null, transactions = 0;
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const collection = name => ({
    listIndexes: () => ({ toArray: async () => name === 'editorialcopies' ? [INDEX] : [{ name: 'editorial_identity_unique',
      unique: true, key: { categoryId: 1, source: 1, editionDate: 1, sourceId: 1 } }] }),
    async findOne(filter, options = {}) {
      return clone((options.session?.data || data)[name]?.find(row => matches(row, filter)) || null);
    },
    async updateOne(filter, update, options = {}) {
      if (name === 'editorialcopies' && options.session && lockConflict) {
        const unknownCommit = lockConflict === 'unknown-commit'; lockConflict = null;
        // Another first import wins outside this transaction's old snapshot.
        data.editorialcopies.push({ _id: filter._id, appId: 'wintips', source, editionDate: day, initialized: true, revision: 1 });
        data.items.push({ source, editionDate: day, isPublished: true, payload: { winning: true } });
        const error = Object.assign(new Error('synthetic copy-lock duplicate'), {
          code: 11000, keyPattern: { _id: 1 }, keyValue: { _id: filter._id },
          hasErrorLabel: value => unknownCommit && value === 'UnknownTransactionCommitResult' });
        throw error;
      }
      const rows = (options.session?.data || data)[name] ||= [];
      let row = rows.find(row => matches(row, filter)), inserted = false;
      if (!row && options.upsert) { row = clone(filter); rows.push(row); inserted = true; }
      if (!row) return { matchedCount: 0, upsertedCount: 0 };
      if (inserted) Object.assign(row, clone(update.$setOnInsert || {}));
      Object.assign(row, clone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
      return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    },
  });
  const model = {
    collection: collection('items'),
    db: { db: { collection }, async startSession() {
      const session = { async endSession() {}, async withTransaction(callback) {
        transactions++;
        let release;
        const prior = tail; tail = new Promise(resolve => { release = resolve; });
        await prior;
        session.data = clone(data);
        try { const value = await callback(); data = session.data; return value; }
        finally { delete session.data; release(); }
      } };
      return session;
    } },
    async bulkWrite(operations, { session }) {
      writes++;
      if (failNextWrite) { failNextWrite = false; throw new Error('synthetic article transaction failure'); }
      if (nextWriteError) { const error = nextWriteError; nextWriteError = null; throw error; }
      let inserted = 0;
      for (const { updateOne: op } of operations) {
        let item = session.data.items.find(row => matches(row, op.filter));
        if (!item) { item = clone(op.filter); session.data.items.push(item); inserted++; }
        Object.assign(item, clone(op.update.$set));
      }
      return { upsertedCount: inserted, matchedCount: operations.length - inserted };
    },
  };
  const Category = { find: () => ({ lean: async () => [{ _id: categoryId, isActive: true, isVip: false, editorialSource: source }] }) };
  const repository = createEditorialRepository({ Category, EditorialItem: model });
  const service = createEditorialService({ repository, clock: () => new Date(day + 'T10:00:00Z'), importEnabled: () => true,
    notifications: { enabled: () => true, async drain() { notifications++; return { sent: 1 }; } } });
  return { service, repository, failNextWrite() { failNextWrite = true; },
    injectWriteError(error) { nextWriteError = error; },
    injectCopyLockConflict(kind = 'duplicate') { lockConflict = kind; },
    get transactions() { return transactions; },
    get data() { return data; }, get writes() { return writes; }, get notifications() { return notifications; } };
}
const batch = item => ({ source, editionDate: day, items: [item] });

test('first Petit import initializes its transaction lock and publishes once; retry cannot change any stored field', async () => {
  const h = harness();
  assert.equal((await h.service.importBatch(batch(payload()))).inserted, 1);
  const before = clone(h.data);
  const changed = payload(9.9); changed.analysis.fr[0].paragraphs = ['Autre analyse qui ne doit pas remplacer la publication.'];
  const retry = await h.service.importBatch(batch(changed));
  assert.equal(retry.ignored, true); assert.equal(retry.reason, PETIT_PUBLISHED);
  assert.equal(retry.imported, 0); assert.equal(retry.notificationsSent, 0);
  assert.deepEqual(h.data, before); assert.equal(h.writes, 1); assert.equal(h.notifications, 1);
});

test('two asynchronous first imports serialize on the source/day copy transaction before either article write', async () => {
  const h = harness();
  const results = await Promise.all([h.service.importBatch(batch(payload(1.4))), h.service.importBatch(batch(payload(8.8)))]);
  assert.equal(results.filter(result => result.ignored === true).length, 1);
  assert.equal(h.writes, 1); assert.equal(h.notifications, 1);
  assert.equal(h.data.items.length, 1); assert.equal(h.data.editorialcopies.length, 1);
  assert.equal(h.data.items[0].payload.selection.odds, 1.4);
  assert.equal(h.data.items[0].contentHash, crypto.createHash('sha256').update(JSON.stringify(h.data.items[0].payload)).digest('hex'));
});

test('legacy published article without copy registry is preserved and transaction leaves no empty copy behind', async () => {
  const h = harness();
  h.data.items.push({ source, editionDate: day, isPublished: true, payload: { untouched: true }, contentHash: 'legacy-hash' });
  const before = clone(h.data);
  const result = await h.service.importBatch(batch(payload()));
  assert.equal(result.ignored, true); assert.equal(result.reason, PETIT_PUBLISHED);
  assert.deepEqual(h.data, before); assert.equal(h.writes, 0); assert.equal(h.notifications, 0);
});

test('legacy notification ledger alone prevents a new message, article or cosmetic copy initialization', async () => {
  const h = harness();
  h.data.editorialnotifications.push({ appId: 'wintips', source, editionDate: day, status: 'completed', notificationId: 'old' });
  const before = clone(h.data);
  assert.equal((await h.service.importBatch(batch(payload()))).ignored, true);
  assert.deepEqual(h.data, before); assert.equal(h.writes, 0); assert.equal(h.notifications, 0);
});

test('failed first article transaction rolls back lock creation so the next first import is still permitted', async () => {
  const h = harness();
  h.failNextWrite();
  await assert.rejects(h.service.importBatch(batch(payload())), /synthetic article transaction failure/);
  assert.deepEqual(h.data, { editorialcopies: [], editorialnotifications: [], items: [] });
  assert.equal((await h.service.importBatch(batch(payload()))).inserted, 1);
  assert.equal(h.writes, 2);
});

test('only one exact copy-lock creation duplicate is retried after abort, then the winning frozen snapshot is ignored', async () => {
  const h = harness(); h.injectCopyLockConflict();
  const result = await h.service.importBatch(batch(payload()));
  assert.equal(result.ignored, true); assert.equal(result.reason, PETIT_PUBLISHED);
  assert.equal(h.transactions, 2); assert.equal(h.writes, 0); assert.equal(h.notifications, 0);
  assert.deepEqual(h.data.items[0].payload, { winning: true });
  assert.equal(h.data.editorialcopies[0].revision, 1);
});

test('an article bulk duplicate and an unknown commit label are never replayed by the copy-lock retry', async () => {
  const h = harness(); h.injectWriteError(Object.assign(new Error('different bulk index duplicate'), {
    code: 11000, keyPattern: { _id: 1 }, keyValue: { _id: 'unrelated-article' } }));
  await assert.rejects(h.service.importBatch(batch(payload())), /different bulk index duplicate/);
  assert.equal(h.transactions, 1); assert.equal(h.writes, 1); assert.equal(h.notifications, 0);
  assert.deepEqual(h.data, { editorialcopies: [], editorialnotifications: [], items: [] });
  const unknown = harness(); unknown.injectCopyLockConflict('unknown-commit');
  await assert.rejects(unknown.service.importBatch(batch(payload())), /synthetic copy-lock duplicate/);
  assert.equal(unknown.transactions, 1); assert.equal(unknown.writes, 0);
});

test('the Petit transaction guard does not freeze existing VIP or Quinte upsert behaviour', async () => {
  for (const other of ['rdj_turf_quinte', 'rdj_football_analysis']) {
    const h = harness();
    const operation = odds => ({ updateOne: {
      filter: { categoryId, source: other, editionDate: day, sourceId: 'existing' },
      update: { $set: { payload: { odds }, contentHash: String(odds), isPublished: true } }, upsert: true,
    } });
    await h.repository.upsertBatch([operation(1.4)], { source: other, editionDate: day, editorialCopy: null });
    await h.repository.upsertBatch([operation(2.1)], { source: other, editionDate: day, editorialCopy: null });
    assert.equal(h.writes, 2); assert.equal(h.data.items[0].payload.odds, 2.1);
  }
});
