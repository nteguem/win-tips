// Explicit opt-in qualification on a NEW isolated QA database. Never loads .env,
// never touches production collections, never prints an URI, never drops a DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const URI = process.env.WINTIPS_PETIT_QA_MONGO_URI;
const OWNER = process.env.WINTIPS_PETIT_QA_OWNER_NONCE;
const DATABASE = process.env.WINTIPS_PETIT_QA_DATABASE;
const { createEditorialRepository } = require('../src/api/services/common/editorialRepository');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { INDEX, copyId, PETIT_PUBLISHED } = require('../src/api/services/common/editorialCopyStorage');
const source = 'rdj_petit_journal';
const clone = value => structuredClone(value);

test('real Mongo Petit lock/rollback/concurrent publication qualification in an owned isolated QA database',
  { skip: !URI, timeout: 180000 }, async () => {
    assert.match(OWNER || '', /^[a-f0-9]{16}$/);
    assert.equal(DATABASE, 'qa_journal_atomic_20261110_' + OWNER);
    assert.match(DATABASE, /^qa_journal_atomic_20261110_[a-f0-9]{16}$/);
    assert.equal(typeof URI, 'string');
    assert.ok(/^mongodb(?:\+srv)?:\/\//.test(URI), 'explicit Mongo URI required');
    const mongoose = require('mongoose');
    let connection;
    try {
      try {
        connection = await mongoose.createConnection(URI, { dbName: DATABASE,
          autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000 }).asPromise();
      } catch (_) { throw new Error('isolated_qa_mongo_connection_failed'); }
      assert.equal(connection.name, DATABASE);
      const db = connection.db;
      assert.equal(db.databaseName, DATABASE);
      // A new nonce must start with an empty database. Never adopt or clean up
      // an existing database, even another previous QA run.
      assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), []);
      await db.collection('qa_ownership').insertOne({ _id: 'owner', nonce: OWNER,
        purpose: 'petit-atomic-20261110', database: DATABASE, createdAt: new Date() });
      async function owned() {
        assert.equal(connection.name, DATABASE);
        const marker = await db.collection('qa_ownership').findOne({ _id: 'owner' });
        assert.equal(marker?.nonce, OWNER); assert.equal(marker?.database, DATABASE);
        assert.equal(marker?.purpose, 'petit-atomic-20261110');
      }
      await owned();
      await db.collection('editorialcopies').createIndex(INDEX.key, { name: INDEX.name, unique: true });
      await db.collection('editorialitems').createIndex({ categoryId: 1, source: 1, editionDate: 1, sourceId: 1 },
        { name: 'editorial_identity_unique', unique: true });
      // All models are injected on this separate connection. The application
      // bootstrap, default mongoose connection and production models stay unused.
      const Item = connection.model('QAEditorialItem', new mongoose.Schema({
        categoryId: mongoose.Schema.Types.ObjectId, source: String, editionDate: String,
        sourceId: String, payload: mongoose.Schema.Types.Mixed, contentHash: String,
        isPublished: Boolean, kind: String, startsAtUtc: Date,
      }, { strict: false, collection: 'editorialitems' }));
      const Category = connection.model('QACategory', new mongoose.Schema({
        isActive: Boolean, isVip: Boolean, catalogueArchived: Boolean, editorialSource: String,
      }, { collection: 'categories' }));
      const category = await Category.create({ isActive: true, isVip: false, catalogueArchived: false, editorialSource: source });
      let notifications = 0;
      const repo = createEditorialRepository({ Category, EditorialItem: Item });
      function service(day, repository = repo) {
        return createEditorialService({ repository, clock: () => new Date(day + 'T08:00:00Z'),
          importEnabled: () => true, notifications: { enabled: () => true,
            async drain() { notifications++; return { sent: 1 }; } } });
      }
      function batch(day, odds = 1.4, id = '101') {
        const [year, month, date] = day.split('-');
        return { source, editionDate: day, items: [{ source, sourceId: id, editionDate: day, kind: 'match',
          sourceUrl: `https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74975-le-petit-journal-${date}-${month}-${year}.html`,
          title: { fr: 'Alpha contre Bravo', en: 'Alpha versus Bravo' },
          summary: { fr: 'Analyse originale.', en: 'Original analysis.' },
          startsAtUtc: day + 'T16:00:00Z', status: 'upcoming', sport: { key: 'football', name: 'Football' },
          competition: { name: 'QA League' }, teams: { home: { name: 'Alpha' }, away: { name: 'Bravo' } },
          analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Analyse originale.'] }],
            en: [{ heading: 'Context', paragraphs: ['Original analysis.'] }] },
          selection: { label: { fr: 'Victoire Alpha', en: 'Alpha to win' }, odds } }] };
      }
      const cases = [];
      await owned();
      const firstService = service('2026-11-10');
      assert.equal((await firstService.importBatch(batch('2026-11-10'))).inserted, 1);
      const original = await Item.findOne({ editionDate: '2026-11-10' }).lean();
      const originalCopy = await db.collection('editorialcopies').findOne({ _id: copyId(source, '2026-11-10') });
      const retry = await firstService.importBatch(batch('2026-11-10', 9.9));
      assert.equal(retry.reason, PETIT_PUBLISHED); assert.equal(retry.ignored, true);
      assert.deepEqual(await Item.findOne({ editionDate: '2026-11-10' }).lean(), original);
      assert.deepEqual(await db.collection('editorialcopies').findOne({ _id: originalCopy._id }), originalCopy);
      cases.push('first_and_changed_retry_immutable');

      await owned();
      const concurrent = service('2026-11-11');
      const results = await Promise.all([concurrent.importBatch(batch('2026-11-11', 1.4, '201')),
        concurrent.importBatch(batch('2026-11-11', 8.8, '202'))]);
      assert.equal(results.filter(row => row.ignored === true).length, 1);
      assert.equal(await Item.countDocuments({ editionDate: '2026-11-11' }), 1);
      cases.push('concurrent_first_imports');

      await owned();
      const legacy = { categoryId: category._id, source, editionDate: '2026-11-12', sourceId: 'legacy',
        isPublished: true, payload: { originalLegacy: true }, contentHash: 'legacy-unchanged' };
      await Item.collection.insertOne(legacy);
      const legacyBefore = await Item.findOne({ editionDate: '2026-11-12' }).lean();
      assert.equal((await service('2026-11-12').importBatch(batch('2026-11-12'))).ignored, true);
      assert.deepEqual(await Item.findOne({ editionDate: '2026-11-12' }).lean(), legacyBefore);
      assert.equal(await db.collection('editorialcopies').countDocuments({ editionDate: '2026-11-12' }), 0);
      cases.push('legacy_no_registry_no_mutation');

      await owned();
      const broken = createEditorialRepository({ Category, EditorialItem: { db: Item.db, collection: Item.collection,
        bulkWrite: async () => { throw new Error('qa_injected_article_failure'); } } });
      await assert.rejects(service('2026-11-13', broken).importBatch(batch('2026-11-13')), /qa_injected_article_failure/);
      assert.equal(await Item.countDocuments({ editionDate: '2026-11-13' }), 0);
      assert.equal(await db.collection('editorialcopies').countDocuments({ editionDate: '2026-11-13' }), 0);
      assert.equal((await service('2026-11-13').importBatch(batch('2026-11-13'))).inserted, 1);
      cases.push('rollback_and_safe_first_retry');

      await owned();
      let injected = false, winningCopy;
      const proxyDb = { collection(name) {
        const actual = db.collection(name);
        if (name !== 'editorialcopies') return actual;
        return { listIndexes: (...args) => actual.listIndexes(...args), findOne: (...args) => actual.findOne(...args),
          async updateOne(filter, update, options) {
            if (!injected && options?.session && options.upsert && filter._id === copyId(source, '2026-11-14')) {
              injected = true;
              await service('2026-11-14').importBatch(batch('2026-11-14', 2.2));
              winningCopy = await actual.findOne({ _id: filter._id });
              throw Object.assign(new Error('qa_injected_exact_lock_duplicate'), { code: 11000,
                keyPattern: { _id: 1 }, keyValue: { _id: filter._id } });
            }
            return actual.updateOne(filter, update, options);
          } };
      } };
      const injectedRepo = createEditorialRepository({ Category, EditorialItem: { collection: Item.collection,
        db: { db: proxyDb, startSession: () => connection.startSession() }, bulkWrite: (...args) => Item.bulkWrite(...args) } });
      assert.equal((await service('2026-11-14', injectedRepo).importBatch(batch('2026-11-14', 9.9))).ignored, true);
      assert.equal(injected, true);
      assert.equal((await Item.findOne({ editionDate: '2026-11-14' }).lean()).payload.selection.odds, 2.2);
      assert.deepEqual(await db.collection('editorialcopies').findOne({ _id: winningCopy._id }), winningCopy);
      cases.push('exact_copy_lock_duplicate_bounded_retry');
      assert.equal(notifications, 4); // only four successful first publications

      await owned();
      await db.collection('qa_evidence').insertOne({ _id: 'completed', ownerNonce: OWNER,
        purpose: 'petit-atomic-20261110', cases, notifications, completedAt: new Date(),
        originalContentHash: original.contentHash,
        proofSha256: crypto.createHash('sha256').update(JSON.stringify(cases)).digest('hex') });
      // Kept for review. No dropDatabase, deleteMany or production data access.
    } finally { if (connection) await connection.close(); }
  });
