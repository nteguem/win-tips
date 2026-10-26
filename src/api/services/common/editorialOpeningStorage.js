const crypto = require('crypto');
const { failure } = require('./editorialSources');
const { OPENING_IDENTITY_INDEX, matchesIndexDefinition } = require('./editorialIndexIdentity');

const COLLECTION = 'editorialopenings';
// One atomic unique receipt is the source of truth. There is no second counter
// to get out of sync, and no replica-set/transaction requirement. No identity,
// device, token, IP, selection or analysis is retained in this registry.
function createOpeningStorage(EditorialItem) {
  const collection = () => EditorialItem.db.db.collection(COLLECTION);
  async function assertStorage() {
    let indexes;
    try { indexes = await collection().listIndexes().toArray(); }
    catch (_) { throw failure('Compteur des ouvertures non initialise', 503); }
    if (!indexes.some(index => matchesIndexDefinition(index, OPENING_IDENTITY_INDEX))) {
      throw failure('Index des ouvertures non initialise', 503);
    }
  }
  return {
    counts: async (categoryIds, editionDate) => !categoryIds.length ? [] : collection().aggregate([
      { $match: { categoryId: { $in: categoryIds }, editionDate } },
      { $group: { _id: '$categoryId', openingCount: { $sum: 1 } } },
    ]).toArray().then(rows => rows.map(row => ({ categoryId: row._id, openingCount: row.openingCount }))),
    async record(categoryId, editionDate, openingId, now) {
      await assertStorage();
      const scope = { categoryId, editionDate }, identity = { ...scope, openingId };
      const key = crypto.createHash('sha256').update(JSON.stringify([String(categoryId), editionDate, openingId])).digest('hex');
      let counted = true;
      try { await collection().insertOne({ _id: key, ...identity, createdAt: now }); }
      catch (error) {
        // Only the exact existing action proves this is a harmless retry. A
        // different conflicting index or corruption must never be swallowed.
        if (error.code !== 11000 || !await collection().findOne(identity, { projection: { _id: 1 } })) throw error;
        counted = false;
      }
      // If this read/HTTP response fails after insertion, the mobile may retry
      // its same UUID. The unique receipt prevents another counted opening.
      const openingCount = await collection().countDocuments(scope);
      return { openingCount, counted };
    },
  };
}
module.exports = { createOpeningStorage, COLLECTION };
