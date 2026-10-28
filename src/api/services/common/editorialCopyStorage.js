const { failure } = require('./editorialSources');
const { digest } = require('./editorialCopy');
const COLLECTION = 'editorialcopies';
const APP = 'wintips';
const INDEX = { key: { appId: 1, source: 1, editionDate: 1 }, name: 'editorial_copy_source_day_unique', unique: true };
const copyId = (source, editionDate) => APP + ':' + source + ':' + editionDate;
function createCopyStorage(EditorialItem) {
  const collection = () => EditorialItem.db.db.collection(COLLECTION);
  async function assertReady() {
    let indexes;
    try { indexes = await collection().listIndexes().toArray(); }
    catch (_) { throw failure('Registre des copies editoriales non initialise', 503); }
    if (!indexes.some(index => index.name === INDEX.name && index.unique === true && JSON.stringify(index.key) === JSON.stringify(INDEX.key))) throw failure('Index des copies editoriales non initialise', 503);
  }
  return {
    assertReady,
    async prepare({ source, editionDate }) {
      await assertReady();
      // Only the explicitly provisioned collection may receive this empty lock.
      // Failed transactions leave no copy decision or article behind.
      try { await collection().updateOne({ _id: copyId(source, editionDate) }, { $setOnInsert: { appId: APP, source, editionDate, initialized: false, revision: 0 } }, { upsert: true }); }
      catch (error) { if (error.code !== 11000) throw error; }
    },
    async lockAndInitialize(context, operations, session) {
      const { source, editionDate } = context, key = { _id: copyId(source, editionDate) };
      const locked = await collection().updateOne(key, { $inc: { revision: 1 } }, { session });
      if (locked.matchedCount !== 1) throw failure('Reservation de copie indisponible', 409);
      const record = await collection().findOne(key, { session });
      if (!record || record.appId !== APP || record.source !== source || record.editionDate !== editionDate) throw failure('Identite de copie incoherente', 409);
      const couponTeaser = require('./couponTeaser').teaserForOperations(context, operations);
      if (record.initialized === true) {
        // This independent, cosmetic caption can be added to a published issue.
        // Never rewrite the frozen copy or its notification hashes/snapshots.
        if (couponTeaser && !require('./couponTeaser').teaserForOperations({ ...context, couponTeaser: record.couponTeaser }, operations)) {
          await collection().updateOne(key, { $set: { couponTeaser } }, { session });
        }
        return;
      }
      // Include archived categories and unpublished rows. An old source/day,
      // even with no prior copy, must never gain a newly generated message.
      const previous = await EditorialItem.collection.findOne({ source, editionDate }, { session, projection: { _id: 1 } });
      const oldLedger = await EditorialItem.db.db.collection('editorialnotifications').findOne({ appId: APP, source, editionDate }, { session, projection: { _id: 1 } });
      const legacy = !!(previous || oldLedger);
      const value = legacy ? null : context.editorialCopy || null;
      const unique = new Map();
      for (const operation of operations) {
        const { filter, update } = operation.updateOne;
        if (filter.source !== source || filter.editionDate !== editionDate) throw failure('Lot de copie incoherent', 409);
        const prior = unique.get(filter.sourceId), contentHash = update.$set.contentHash;
        if (prior && prior !== contentHash) throw failure('Contenu de copie incoherent', 409);
        unique.set(filter.sourceId, contentHash);
      }
      const saved = await collection().updateOne({ ...key, initialized: false }, { $set: {
        initialized: true, legacy, copy: value, copySha256: value ? digest(value) : null,
        itemHashes: value ? [...unique].map(([sourceId, contentHash]) => ({ sourceId, contentHash })) : [],
        ...(couponTeaser ? { couponTeaser } : {}),
      } }, { session });
      if (saved.matchedCount !== 1) throw failure('Reservation de copie perdue', 409);
    },
    async read(sources, editionDate) {
      // A missing cosmetic registry must not break historical/public reads.
      try {
        await assertReady();
        return await collection().find({ appId: APP, source: { $in: sources }, editionDate, initialized: true }).toArray();
      } catch (_) { return []; }
    },
    async states(sources, editionDate) {
      const unknown = () => sources.map(source => ({ source, state: 'unknown', legacy: false }));
      try {
        await assertReady();
        return await Promise.all(sources.map(async source => {
          const record = await collection().findOne({ _id: copyId(source, editionDate) });
          if (record && (record.appId !== APP || record.source !== source || record.editionDate !== editionDate || typeof record.initialized !== 'boolean')) throw new Error('copy_identity');
          if (record?.initialized) return { source, state: 'frozen', legacy: record.legacy === true };
          const oldItem = await EditorialItem.collection.findOne({ source, editionDate }, { projection: { _id: 1 } });
          const oldLedger = await EditorialItem.db.db.collection('editorialnotifications').findOne({ appId: APP, source, editionDate }, { projection: { _id: 1 } });
          return { source, state: oldItem || oldLedger ? 'frozen' : 'new', legacy: !!(oldItem || oldLedger) };
        }));
      } catch (_) { return unknown(); }
    },
    async teaserStates(sources, editionDate) {
      const unknown = () => sources.map(source => ({ source, state: 'unknown' }));
      try {
        await assertReady();
        const [records, rows] = await Promise.all([
          collection().find({ appId: APP, source: { $in: sources }, editionDate, initialized: true }).toArray(),
          EditorialItem.collection.find({ source: { $in: sources }, editionDate, isPublished: true }).limit(301).toArray(),
        ]);
        if (rows.length > 300) return unknown();
        const { boundTeaser } = require('./couponTeaser');
        return sources.map(source => ({ source, state: boundTeaser(records.find(row => row.source === source),
          rows.filter(row => row.source === source)) ? 'ready' : 'missing' }));
      } catch (_) { return unknown(); }
    },
  };
}
module.exports = { COLLECTION, INDEX, copyId, createCopyStorage };
