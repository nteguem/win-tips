const { failure } = require('./editorialSources');

function createEditorialRepository({ Category, EditorialItem, subscriptionService, accessGateService }) {
  return {
  categories: () => Category.find({ isActive: true, editorialSource: { $in: require('./editorialSources').SOURCES.map(s => s.key) } }).lean(),
  category: id => Category.findById(id).lean(),
  items: (ids, date) => EditorialItem.find({ categoryId: { $in: ids }, editionDate: date, isPublished: true }).sort({ startsAtUtc: 1, sourceId: 1 }).lean(),
  item: id => EditorialItem.findOne({ _id: id, isPublished: true }).lean(),
  hasCategoryAccess: (userId, categoryId) => subscriptionService.hasAccessToCategory(userId, categoryId),
  hasAnySubscription: async userId => (await subscriptionService.getActiveSubscriptions(userId)).some(sub => sub.package),
  gate: (userId, category, isSubscriber) => accessGateService.getCategoryGateState(userId, category, { isSubscriber }),
  upsertBatch: async operations => {
    // Deployment explicitly prepares this index after operator approval. A read
    // request/import must never create collections/indexes behind the scenes.
    let indexes;
    try { indexes = await EditorialItem.collection.listIndexes().toArray(); }
    catch (_) { throw failure('Stockage editorial non initialise', 503); }
    const keys = { categoryId: 1, source: 1, editionDate: 1, sourceId: 1 };
    if (!indexes.some(index => index.name === 'editorial_identity_unique' && index.unique === true && JSON.stringify(index.key) === JSON.stringify(keys))) {
      throw failure('Index editorial de deduplication non initialise', 503);
    }
    return EditorialItem.bulkWrite(operations, { ordered: true });
  },
};
}

let defaultRepository;
function getDefaultRepository() {
  if (!defaultRepository) defaultRepository = createEditorialRepository({
    Category: require('../../models/common/Category'), EditorialItem: require('../../models/common/EditorialItem'),
    subscriptionService: require('../user/subscriptionService'), accessGateService: require('./accessGateService'),
  });
  return defaultRepository;
}
const methods = ['categories', 'category', 'items', 'item', 'hasCategoryAccess', 'hasAnySubscription', 'gate', 'upsertBatch'];
module.exports = { createEditorialRepository, ...Object.fromEntries(methods.map(name => [name, (...args) => getDefaultRepository()[name](...args)])) };
