const crypto = require('crypto');
const { snapshotForPackage } = require('./subscriptionEntitlements');

function assertBinding(tx, { userId, packageId, productId }) {
  if (String(tx.user) !== String(userId) || String(tx.package) !== String(packageId) || tx.productId !== productId) {
    throw new Error('Cette transaction appartient a une autre activation');
  }
}

// Only the new managed catalogue uses this transaction. Provider verification
// happens first; acknowledge/consume happens after both writes are committed.
function createManagedGoogleActivation({ GooglePlayTransaction, Subscription }) {
  return async function activate({ purchaseToken, productId, userId, packageId, pkg, price, data, appPackageName }) {
    const binding = { userId, packageId, productId };
    const session = await GooglePlayTransaction.db.startSession();
    let subscriptionId;
    try {
      await session.withTransaction(async () => {
        const existing = await GooglePlayTransaction.findOne({ purchaseToken }).session(session);
        if (existing) {
          assertBinding(existing, binding);
          if (existing.subscription) {
            const sub = await Subscription.findById(existing.subscription).session(session);
            if (!sub || String(sub.user) !== String(userId) || String(sub.package) !== String(packageId)) throw new Error('Activation incoherente; verification necessaire');
            subscriptionId = sub._id;
            return;
          }
        }
        const startDate = existing?.startTime || new Date();
        const endDate = existing?.expiryTime || new Date(startDate.getTime() + pkg.duration * 86400000);
        if (!Number.isFinite(endDate.getTime())) throw new Error('Duree du forfait invalide');
        // The token digest is never returned. Its deterministic _id closes the
        // concurrency window even before a token index is explicitly prepared.
        const txId = existing?._id || crypto.createHash('sha256').update(String(appPackageName) + '|' + purchaseToken).digest('hex').slice(0, 24);
        if (!existing) await GooglePlayTransaction.create([{
          _id: txId, purchaseToken, productId, user: userId, package: packageId,
          orderId: data.orderId || 'GP_MANAGED_' + txId, status: 'ACTIVE',
          startTime: startDate, expiryTime: endDate,
          purchaseTime: data.purchaseTimeMillis ? new Date(Number(data.purchaseTimeMillis)) : startDate,
          priceAmountMicros: Math.round(price.amount * 1000000), priceCurrencyCode: price.currency,
          priceEvidence: price.source, autoRenewing: false, acknowledged: data.acknowledgementState === 1,
          purchaseType: 'ONE_TIME_PRODUCT', consumptionState: data.consumptionState === 1 ? 'CONSUMED' : 'YET_TO_BE_CONSUMED', quantity: 1, refundableQuantity: 1,
        }], { session });
        const [sub] = await Subscription.create([{
          user: userId, package: packageId, startDate, endDate, ...snapshotForPackage(pkg),
          pricing: { amount: price.amount, currency: price.currency, source: price.source },
          status: 'active', paymentProvider: 'GOOGLE_PLAY',
          paymentReference: existing?.orderId || data.orderId || 'GP_MANAGED_' + txId,
          googlePlayTransaction: txId, autoRenewing: false,
        }], { session });
        await GooglePlayTransaction.updateOne({ _id: txId }, { $set: { subscription: sub._id } }, { session });
        subscriptionId = sub._id;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error.code !== 11000) throw error;
      // A concurrent winner may have committed the deterministic token id.
      const winner = await GooglePlayTransaction.findOne({ purchaseToken });
      if (!winner) throw error;
      assertBinding(winner, binding);
      if (!winner.subscription) throw new Error('Activation en cours; reessayez');
      subscriptionId = winner.subscription;
    } finally { await session.endSession(); }
    const subscription = await Subscription.findById(subscriptionId).populate('package');
    if (!subscription || String(subscription.user) !== String(userId) || String(subscription.package?._id || subscription.package) !== String(packageId)) throw new Error('Abonnement non attribue');
    return subscription;
  };
}
module.exports = { createManagedGoogleActivation, assertBinding };
