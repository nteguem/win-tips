const { failure } = require('./editorialSources');
const crypto = require('node:crypto');
const { SOURCE } = require('./dailyVipValidation');
const DAILY_INDEX = Object.freeze({ name: 'editorial_daily_vip_one_per_day', key: { categoryId: 1, source: 1, editionDate: 1 }, unique: true,
  partialFilterExpression: { source: SOURCE } });
function exactIndex(index) {
  return index.name === DAILY_INDEX.name && index.unique === true && JSON.stringify(index.key) === JSON.stringify(DAILY_INDEX.key) &&
    JSON.stringify(index.partialFilterExpression) === JSON.stringify(DAILY_INDEX.partialFilterExpression) && !index.sparse && !index.hidden && !Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds') && !index.collation;
}
async function publishImmutable(collection, operation) {
  const { filter, update } = operation.updateOne;
  if (filter.source !== SOURCE || update.$set?.payload?.source !== SOURCE || filter.sourceId !== `daily-vip-${filter.editionDate}`) throw failure('Identite du combine quotidien incoherente', 409);
  let indexes;
  try { indexes = await collection.listIndexes().toArray(); } catch (_) { throw failure('Stockage du combine quotidien non initialise', 503); }
  if (!indexes.some(exactIndex)) throw failure('Index du combine quotidien non initialise', 503);
  const identity = { categoryId: filter.categoryId, source: SOURCE, editionDate: filter.editionDate };
  let result;
  // One atomic insert. No retry can rewrite a public prediction after kickoff,
  // change its identity, or replace a losing coupon with another selection.
  try { result = await collection.updateOne(identity, { $setOnInsert: { ...filter, ...update.$set, ...update.$setOnInsert, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true, writeConcern: { w: 'majority' } }); }
  catch (error) { if (error.code !== 11000) throw error; result = { upsertedCount: 0, matchedCount: 1 }; }
  const stored = await collection.findOne(identity);
  if (!stored || stored.sourceId !== filter.sourceId || stored.contentHash !== update.$set.contentHash || stored.isPublished !== true ||
      crypto.createHash('sha256').update(JSON.stringify(stored.payload)).digest('hex') !== stored.contentHash)
    throw failure('Le combine de cette journee est deja publie et ne peut plus etre remplace', 409, 'DAILY_VIP_IMMUTABLE');
  return { upsertedCount: result.upsertedCount || 0, matchedCount: result.upsertedCount ? 0 : 1 };
}
module.exports = { DAILY_INDEX, exactIndex, publishImmutable };
