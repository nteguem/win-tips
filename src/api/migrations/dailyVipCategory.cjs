// Explicit plan/apply helper. Importing this module never connects or writes.
// Operator supplies the existing WinTips Mongo connection and stores the plan
// privately as the preimage backup before apply. No customer details are logged.
const crypto = require('node:crypto');
const { DAILY_INDEX, exactIndex } = require('../services/common/dailyVipStorage');
const { SOURCE } = require('../services/common/dailyVipValidation');
const PACKAGE_ID = 'c97d577e0912523aab9f1bfb';
const CATEGORY_ID = '691b1dd577e0912523aab901';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const str = value => String(value && value._id || value);
const same = (a, b) => hash(a) === hash(b);
function fail(message) { throw Object.assign(new Error(message), { code: 'DAILY_VIP_MIGRATION_CONFLICT' }); }
function eligiblePackage(pkg) {
  return pkg && str(pkg._id) === PACKAGE_ID && pkg.isActive === true && pkg.duration === 1 && pkg.pricing?.XAF === 1000 &&
    (pkg.name?.fr || '').toLowerCase() === 'black friday' && Array.isArray(pkg.categories) && pkg.categories.length > 0;
}
async function plan(db, ObjectId, { now = new Date() } = {}) {
  if (db.databaseName !== 'wintips') fail('Cette migration est exclusivement destinee a WinTips');
  const packageId = new ObjectId(PACKAGE_ID), categoryId = new ObjectId(CATEGORY_ID);
  const pkg = await db.collection('packages').findOne({ _id: packageId });
  if (!eligiblePackage(pkg)) fail('Le forfait Black Friday attendu doit etre actif a 1000 XAF pour un jour');
  const matches = await db.collection('categories').find({ $or: [{ _id: categoryId }, { editorialSource: SOURCE }, { catalogueKey: SOURCE }] }).toArray();
  if (matches.length > 1 || matches.length === 1 && (str(matches[0]._id) !== CATEGORY_ID || matches[0].editorialSource !== SOURCE || matches[0].isVip !== true || matches[0].isActive !== true)) fail('Categorie existante incompatible');
  const category = matches[0] || null;
  const subscriptions = await db.collection('subscriptions').find({ package: packageId, status: 'active', startDate: { $lte: now }, endDate: { $gt: now } }).toArray();
  const updates = subscriptions.filter(sub => !(sub.categorySnapshot || pkg.categories).some(id => str(id) === CATEGORY_ID)).map(sub => ({
    before: sub,
    categories: [...(Array.isArray(sub.categorySnapshot) ? sub.categorySnapshot : pkg.categories), categoryId],
  }));
  const indexes = await db.collection('editorialitems').listIndexes().toArray();
  const named = indexes.find(index => index.name === DAILY_INDEX.name);
  if (named && !exactIndex(named)) fail('Index du combine existant incompatible');
  return { version: 1, database: 'wintips', createdAt: now.toISOString(), package: pkg, category, subscriptions: updates,
    categoryId, indexNeeded: !named, packageUpdate: !pkg.categories.some(id => str(id) === CATEGORY_ID),
    categoryDefinition: { _id: categoryId, catalogueKey: SOURCE, catalogueArchived: false,
      name: { fr: 'Combiné du jour', en: 'Daily Accumulator' },
      description: { fr: 'Deux ou trois sélections, objectif de cote 3 à 3,5. Aucun gain garanti.', en: 'Two or three selections. Target odds 3–3.5. No guaranteed return.' },
      icon: '🎯', isVip: true, isActive: true, editorialSource: SOURCE, externalSources: [], createdAt: now, updatedAt: now },
  };
}
async function apply(db, startSession, prepared, { now = new Date(), confirm = false } = {}) {
  if (!confirm) fail('Confirmation explicite requise');
  if (prepared.version !== 1 || prepared.database !== 'wintips' || db.databaseName !== 'wintips' || !eligiblePackage(prepared.package) || str(prepared.categoryId) !== CATEGORY_ID) fail('Plan incompatible');
  // Index provisioning cannot run in a transaction. It is additive and never
  // drops/replaces an existing index, category, package or entitlement.
  const collection = db.collection('editorialitems');
  const indexes = await collection.listIndexes().toArray();
  const named = indexes.find(index => index.name === DAILY_INDEX.name);
  if (named && !exactIndex(named)) fail('Index incompatible');
  if (!named) { const { key, ...options } = DAILY_INDEX; await collection.createIndex(key, options); }
  const session = await startSession();
  try {
    return await session.withTransaction(async () => {
      const options = { session };
      const currentPackage = await db.collection('packages').findOne({ _id: prepared.package._id }, options);
      if (!same(currentPackage, prepared.package)) fail('Le forfait a change depuis le plan');
      const currentCategory = await db.collection('categories').findOne({ _id: prepared.categoryId }, options);
      if (!same(currentCategory, prepared.category)) fail('La categorie a change depuis le plan');
      const sourceMappings = await db.collection('categories').find({ $or: [{ _id: prepared.categoryId }, { editorialSource: SOURCE }, { catalogueKey: SOURCE }] }, options).toArray();
      if (sourceMappings.length !== (prepared.category ? 1 : 0) || sourceMappings.some(category => str(category._id) !== CATEGORY_ID)) fail('La source a change depuis le plan');
      const currentSubscriptions = await db.collection('subscriptions').find({ package: prepared.package._id, status: 'active', startDate: { $lte: now }, endDate: { $gt: now } }, options).toArray();
      const missingRights = currentSubscriptions.filter(sub => !(sub.categorySnapshot || currentPackage.categories).some(id => str(id) === CATEGORY_ID));
      if (missingRights.length !== prepared.subscriptions.length || missingRights.some(sub => !prepared.subscriptions.some(change => str(change.before._id) === str(sub._id) && same(change.before, sub)))) fail('Les abonnements ont change depuis le plan');
      if (!prepared.category) await db.collection('categories').insertOne(prepared.categoryDefinition, options);
      if (prepared.packageUpdate) {
        const result = await db.collection('packages').updateOne({ _id: prepared.package._id, categories: prepared.package.categories },
          { $addToSet: { categories: prepared.categoryId } }, options);
        if (result.matchedCount !== 1) fail('Le forfait a change');
      }
      let updated = 0;
      for (const change of prepared.subscriptions) {
        const before = change.before, current = await db.collection('subscriptions').findOne({ _id: before._id }, options);
        if (!same(current, before) || current.status !== 'active' || new Date(current.endDate) <= now) fail('Un abonnement a change ou expire depuis le plan');
        const filter = { _id: before._id, package: before.package, status: 'active', endDate: before.endDate,
          categorySnapshot: before.categorySnapshot === undefined ? { $exists: false } : before.categorySnapshot };
        const result = await db.collection('subscriptions').updateOne(filter, { $set: { categorySnapshot: change.categories } }, options);
        if (result.matchedCount !== 1) fail('Un abonnement a change');
        updated++;
      }
      return { categoryId: CATEGORY_ID, categoryCreated: !prepared.category, packageUpdated: prepared.packageUpdate, subscriptionsUpdated: updated,
        deadlinesChanged: false, pricesChanged: false, notificationsEnabled: false };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
}
module.exports = { plan, apply, PACKAGE_ID, CATEGORY_ID, eligiblePackage };
