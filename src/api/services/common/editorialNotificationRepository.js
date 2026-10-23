const crypto = require('crypto');
const { sourceMatchesCategory } = require('./editorialService');
const { failure } = require('./editorialSources');

const id = value => String(value && value._id || value);
const identityKeys = { appId: 1, categoryId: 1, source: 1, editionDate: 1 };
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createEditorialNotificationRepository({ Category, EditorialItem, EditorialNotification, Device, PushDelivery, Subscription, User }) {
  return {
  async assertIndexes() {
    try {
      const [notificationIndexes, deliveryIndexes] = await Promise.all([
        EditorialNotification.collection.listIndexes().toArray(), PushDelivery.collection.listIndexes().toArray(),
      ]);
      if (!notificationIndexes.some(index => index.name === 'editorial_notification_identity_unique' && index.unique && sameKey(index.key, identityKeys)) ||
          !deliveryIndexes.some(index => index.unique && sameKey(index.key, { msgId: 1 }))) throw new Error('missing_index');
    } catch (_) { throw failure('Index de notification non initialise', 503); }
  },
  async groups({ source, editionDate }) {
    const categories = (await Category.find({ isActive: true, editorialSource: source || { $ne: null } }).lean()).filter(sourceMatchesCategory);
    const items = await EditorialItem.find({ categoryId: { $in: categories.map(category => category._id) }, editionDate, isPublished: true }).sort({ startsAtUtc: 1, sourceId: 1 }).lean();
    return categories.map(category => ({ category, source: category.editorialSource, editionDate,
      items: items.filter(item => id(item.categoryId) === id(category) && item.source === category.editorialSource) }));
  },
  async categoryStillMatches(key, isVip) {
    return !!await Category.exists({ _id: key.categoryId, isActive: true, editorialSource: key.source, isVip });
  },
  async claim(key, notificationId, now) {
    try {
      await EditorialNotification.updateOne(key, { $setOnInsert: { ...key, notificationId, status: 'pending', afterDeviceId: null, passes: 0 } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
    return EditorialNotification.findOneAndUpdate({ ...key,
      status: { $in: ['pending', 'processing', 'retry_pending'] },
      $and: [ { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] } ],
    }, { $set: { status: 'processing', lockToken: crypto.randomUUID(), leaseUntil: new Date(now.getTime() + 5 * 60000) }, $inc: { passes: 1 } }, { new: true }).lean();
  },
  async checkpoint(key, lockToken, afterDeviceId, now) {
    const result = await EditorialNotification.updateOne({ ...key, status: 'processing', lockToken }, {
      $set: { afterDeviceId, leaseUntil: new Date(now.getTime() + 5 * 60000) },
    });
    if (!result.matchedCount) throw failure('Bail de notification perdu', 409);
  },
  async finish(key, lockToken, fields, now) {
    await EditorialNotification.updateOne({ ...key, status: 'processing', lockToken }, { $set: {
      ...fields, leaseUntil: null, lockToken: null,
      ...(['completed', 'no_audience', 'review_required'].includes(fields.status) ? { completedAt: now } : {}),
    } });
  },
  deviceBatch: (afterDeviceId, limit) => Device.find({ isActive: true, notificationsEnabled: { $ne: false }, editorialSchemaVersion: 1,
    pushProvider: { $ne: 'unreachable' }, ...(afterDeviceId ? { _id: { $gt: afterDeviceId } } : {}),
    $or: [{ fcmToken: { $type: 'string', $ne: '' } }, { playerId: { $type: 'string', $ne: '' } }],
  }).select('_id deviceId user language deviceLanguage notificationsEnabled editorialSchemaVersion').sort({ _id: 1 }).limit(limit).lean(),
  async entitledUsers(categoryId, userIds, now) {
    if (!userIds.length) return [];
    const active = await User.find({ _id: { $in: userIds }, isActive: true }).select('_id').lean();
    // Match the existing access service and Subscription.find middleware:
    // current active subscriptions, current package category membership,
    // without requiring that a formerly purchased package is still on sale.
    const subscriptions = await Subscription.find({ user: { $in: active.map(user => user._id) }, status: 'active', endDate: { $gt: now } })
      .select('user package').populate({ path: 'package', select: 'categories' }).lean();
    return [...new Set(subscriptions.filter(sub => sub.package && sub.package.categories.some(cat => id(cat) === categoryId)).map(sub => id(sub.user)))];
  },
  async deliverySummary(appId, notificationId) {
    const groups = await PushDelivery.aggregate([
      { $match: { appId, notificationId } },
      { $group: { _id: { status: '$status', retrySafe: '$retrySafe', attempts: '$attempts' }, count: { $sum: 1 } } },
    ]);
    const result = { accepted: 0, retryable: 0, failed: 0, uncertain: 0 };
    for (const group of groups) {
      if (['sent', 'acked'].includes(group._id.status)) result.accepted += group.count;
      else if (group._id.status === 'failed' && group._id.retrySafe === true && group._id.attempts < 5) result.retryable += group.count;
      else if (group._id.status === 'failed') result.failed += group.count;
      else result.uncertain += group.count;
    }
    return result;
  },
};
}

let defaultRepository;
function getEditorialNotificationRepository() {
  if (!defaultRepository) defaultRepository = createEditorialNotificationRepository({
    Category: require('../../models/common/Category'), EditorialItem: require('../../models/common/EditorialItem'),
    EditorialNotification: require('../../models/common/EditorialNotification'), Device: require('../../models/common/Device'),
    PushDelivery: require('../../models/common/PushDelivery'), Subscription: require('../../models/common/Subscription'), User: require('../../models/user/User'),
  });
  return defaultRepository;
}
module.exports = { createEditorialNotificationRepository, getEditorialNotificationRepository };
