const { failure } = require('./editorialSources');
const { REVIEW_IDENTITY_INDEX, matchesIndexDefinition } = require('./editorialIndexIdentity');

function createEditorialRepository({ Category, EditorialItem, EditorialReview, subscriptionService, accessGateService }) {
  const copies = () => require('./editorialCopyStorage').createCopyStorage(EditorialItem);
  const tickets = () => require('./editorialTickets');
  const stateCollection = () => EditorialItem.db.db.collection('editorialticketstates');
  const reviewsModel = () => EditorialReview || require('../../models/common/EditorialReview');
  const openings = () => require('./editorialOpeningStorage').createOpeningStorage(EditorialItem);
  async function reviewStorage() {
    let indexes;
    try { indexes = await reviewsModel().collection.listIndexes().toArray(); }
    catch (_) { throw failure('Stockage des avis non initialise', 503); }
    if (!indexes.some(index => matchesIndexDefinition(index, REVIEW_IDENTITY_INDEX))) throw failure('Index des avis non initialise', 503);
  }
  async function ticketStorage() {
    let indexes;
    try { indexes = await stateCollection().listIndexes().toArray(); }
    catch (_) { throw failure('Registre des tickets non initialise', 503); }
    if (!indexes.some(index => index.name === 'editorial_ticket_edition_unique' && index.unique === true && JSON.stringify(index.key) === JSON.stringify({ editionDate: 1 }))) throw failure('Index du registre des tickets non initialise', 503);
  }
  async function readTicketState(editionDate, session) {
    const options = session ? { session } : {};
    const stored = await stateCollection().findOne({ _id: editionDate }, options);
    if (!stored && await stateCollection().findOne({ editionDate }, options)) throw failure('Identite du registre des tickets incoherente', 409);
    // Old imported rows predate reservations. Include inactive/archived mappings
    // and unpublished rows too: a published ticket must not silently change owner.
    const rows = await EditorialItem.collection.find({ editionDate, source: { $in: tickets().TICKET_SOURCES } }, { ...options, projection: { source: 1, editionDate: 1, sourceId: 1, payload: 1 } }).toArray();
    return tickets().mergeState(editionDate, stored, rows);
  }
  return {
  categories: () => Category.find({ isActive: true, catalogueArchived: { $ne: true }, editorialSource: { $in: require('./editorialSources').SOURCES.map(s => s.key) } }).lean(),
  category: id => Category.findById(id).lean(),
  items: (ids, date) => EditorialItem.find({ categoryId: { $in: ids }, editionDate: date, isPublished: true }).sort({ startsAtUtc: 1, sourceId: 1 }).lean(),
  availableDates: (ids, today, limit = 10, mappings) => !ids.length ? [] : EditorialItem.aggregate([
    { $match: { categoryId: { $in: ids }, isPublished: true, editionDate: { $lte: today },
      ...(mappings?.length ? { $or: mappings.map(mapping => ({ categoryId: mapping.categoryId, source: mapping.source })) } : {}) } },
    { $group: { _id: '$editionDate' } }, { $sort: { _id: -1 } }, { $limit: Math.min(10, limit) },
  ]).then(rows => rows.map(row => row._id)),
  reviewSummaries: (ids, date) => !ids.length ? [] : reviewsModel().aggregate([
    { $match: { categoryId: { $in: ids }, editionDate: date } },
    { $group: { _id: '$categoryId', count: { $sum: 1 }, averageRating: { $avg: '$rating' } } },
  ]).then(rows => rows.map(row => ({ categoryId: row._id, count: row.count, averageRating: row.averageRating }))),
  openingCounts: (ids, date) => openings().counts(ids, date),
  recordOpening: (categoryId, editionDate, openingId, now) => openings().record(categoryId, editionDate, openingId, now),
  reviews: async (categoryId, editionDate, { page, limit }) => {
    const filter = { categoryId, editionDate };
    const [rows, total] = await Promise.all([
      reviewsModel().find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      reviewsModel().countDocuments(filter),
    ]);
    return { rows, total };
  },
  userReview: (categoryId, editionDate, userId) => reviewsModel().findOne({ categoryId, editionDate, userId }).lean(),
  upsertReview: async (categoryId, editionDate, userId, values) => {
    await reviewStorage();
    const filter = { categoryId, editionDate, userId };
    const update = { $set: { rating: values.rating, comment: values.comment, authorName: values.authorName } };
    try { return await reviewsModel().findOneAndUpdate(filter, update, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }).lean(); }
    catch (error) {
      if (error.code !== 11000) throw error;
      // Concurrent first submissions converge on the same unique reader/edition.
      const row = await reviewsModel().findOneAndUpdate(filter, update, { new: true, runValidators: true }).lean();
      if (!row) throw failure('Avis indisponible', 503);
      return row;
    }
  },
  // Include unpublished rows so a partial/current mapping cannot look complete.
  // This optional optimisation never creates data, collections or indexes.
  sourceWindowItems: (ids, date) => EditorialItem.find({ categoryId: { $in: ids }, editionDate: date,
    source: { $in: ['rdj_petit_journal', 'rdj_turf_quinte'] } })
    .select('categoryId source editionDate sourceId kind startsAtUtc payload contentHash isPublished').limit(51).lean(),
  item: id => EditorialItem.findOne({ _id: id, isPublished: true }).lean(),
  copies: (sources, date) => copies().read(sources, date),
  copyStates: (sources, date) => copies().states(sources, date),
  hasCategoryAccess: (userId, categoryId) => subscriptionService.hasAccessToCategory(userId, categoryId),
  hasAnySubscription: async userId => (await subscriptionService.getActiveSubscriptions(userId)).some(sub => sub.package),
  gate: (userId, category, isSubscriber) => accessGateService.getCategoryGateState(userId, category, { isSubscriber }),
  ticketState: async editionDate => {
    try { await ticketStorage(); return { ready: true, ...await readTicketState(editionDate) }; }
    catch (_) { return { ready: false, editionDate, reason: 'ticket_reservations_require_review' }; }
  },
  upsertBatch: async (operations, copyContext) => {
    // Deployment explicitly prepares this index after operator approval. A read
    // request/import must never create collections/indexes behind the scenes.
    let indexes;
    try { indexes = await EditorialItem.collection.listIndexes().toArray(); }
    catch (_) { throw failure('Stockage editorial non initialise', 503); }
    const keys = { categoryId: 1, source: 1, editionDate: 1, sourceId: 1 };
    if (!indexes.some(index => index.name === 'editorial_identity_unique' && index.unique === true && JSON.stringify(index.key) === JSON.stringify(keys))) {
      throw failure('Index editorial de deduplication non initialise', 503);
    }
    const hasDuo = operations.some(op => op.updateOne.filter.source === 'rdj_football_duo');
    if (hasDuo && !indexes.some(index => index.name === 'editorial_duo_one_per_day' && index.unique === true &&
      JSON.stringify(index.key) === JSON.stringify({ categoryId: 1, source: 1, editionDate: 1 }) && index.partialFilterExpression?.source === 'rdj_football_duo')) throw failure('Index du Duo unique par jour non initialise', 503);
    const ticketOps = operations.filter(op => tickets().TICKET_SOURCES.includes(op.updateOne.filter.source));
    try {
      if (!ticketOps.length && !copyContext) return await EditorialItem.bulkWrite(operations, { ordered: true });
      if (copyContext) await copies().prepare(copyContext);
      if (ticketOps.length) await ticketStorage();
      const dates = [...new Set(ticketOps.map(op => op.updateOne.filter.editionDate))];
      if (ticketOps.length && (dates.length !== 1 || ticketOps.length !== operations.length)) throw failure('Un lot de tickets doit porter sur une seule edition', 409);
      const editionDate = dates[0], collection = stateCollection();
      // Create only a document in the explicitly provisioned collection. The
      // per-edition write serializes both families, including different workers.
      if (ticketOps.length) {
        try { await collection.updateOne({ _id: editionDate }, { $setOnInsert: { ...tickets().emptyState(editionDate), revision: 0 } }, { upsert: true }); }
        catch (error) { if (error.code !== 11000) throw error; }
      }
      const session = await EditorialItem.db.startSession();
      try {
        return await session.withTransaction(async () => {
          if (copyContext) await copies().lockAndInitialize(copyContext, operations, session);
          let state;
          if (ticketOps.length) {
            const locked = await collection.updateOne({ _id: editionDate }, { $inc: { revision: 1 } }, { session });
            if (locked.matchedCount !== 1) throw failure('Reservation du ticket indisponible', 409);
            state = await readTicketState(editionDate, session);
            for (const operation of ticketOps) {
              const { filter, update } = operation.updateOne, item = update.$set.payload;
              if (filter.sourceId !== item.sourceId) throw failure('Identite de ticket incoherente', 409);
              tickets().reserve(state, filter.source, tickets().entryFor(item));
            }
          }
          const result = await EditorialItem.bulkWrite(operations, { ordered: true, session });
          if (state) {
            const saved = await collection.updateOne({ _id: editionDate }, { $set: state }, { session });
            if (saved.matchedCount !== 1) throw failure('Reservation du ticket indisponible', 409);
          }
          return result;
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } finally { await session.endSession(); }
    }
    catch (error) {
      if (hasDuo && error.code === 11000) throw failure('Le Duo du Jour de cette edition est deja choisi; son identite doit etre conservee', 409);
      throw error;
    }
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
const methods = ['categories', 'category', 'items', 'availableDates', 'reviewSummaries', 'openingCounts', 'recordOpening', 'reviews', 'userReview', 'upsertReview', 'sourceWindowItems', 'item', 'copies', 'copyStates', 'hasCategoryAccess', 'hasAnySubscription', 'gate', 'ticketState', 'upsertBatch'];
module.exports = { createEditorialRepository, ...Object.fromEntries(methods.map(name => [name, (...args) => getDefaultRepository()[name](...args)])) };
