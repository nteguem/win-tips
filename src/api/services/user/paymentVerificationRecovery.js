// Bounded recovery for payment webhooks that are delayed or lost. Neither
// elapsed time nor an HTTP timeout proves that money was not collected.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;
const BATCH_SIZE = 300;

// `/me` must remain usable during a PSP outage. The single shared deadline
// bounds waiting only: authenticated receipt checks and access activation keep
// running, with rejection handlers attached even after the HTTP caller returns.
async function waitForUserRecovery(operations, budgetMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(results => ({ completed: true, results })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false, results: null }), budgetMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nextInterval(transaction, now = Date.now()) {
  const age = now - new Date(transaction.createdAt).getTime();
  if (age < 5 * 60 * 1000) return 60 * 1000;
  if (age < 30 * 60 * 1000) return 5 * 60 * 1000;
  if (age < 24 * 60 * 60 * 1000) return 30 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

function shouldCheckNow(transaction, now = Date.now()) {
  const createdAt = new Date(transaction.createdAt).getTime();
  if (!Number.isFinite(createdAt) || now - createdAt > MAX_AGE_MS) return false;
  if (transaction.nextCheckAt) return new Date(transaction.nextCheckAt).getTime() <= now;
  if (!transaction.lastCheckedAt) return true;
  return now - new Date(transaction.lastCheckedAt).getTime() >= nextInterval(transaction, now);
}

function createRecovery({ Model, service, referenceField, successStatus, label, paymentMiddleware }) {
  const pendingStatuses = ['PENDING', 'INITIATED', 'WAITING_FOR_CUSTOMER', 'FAILED', 'REFUSED', 'ERROR', 'EXPIRED', 'CANCELED', 'CANCELLED'];
  let running = null;

  function candidateQuery(userId, now) {
    return {
      ...(userId ? { user: userId } : {}),
      createdAt: { $gte: new Date(now - MAX_AGE_MS) },
      $or: [
        { status: successStatus, $or: [{ processed: { $ne: true } }, { subscriptionId: { $exists: false } }, { subscriptionId: null }] },
        { status: { $in: pendingStatuses } }
      ]
    };
  }

  async function verifyOne(transaction) {
    try {
      const now = Date.now();
      // A lease prevents /status, /me and cron from querying the same receipt
      // simultaneously. It is metadata only: it never changes payment status.
      const claimed = await Model.findOneAndUpdate(
        {
          _id: transaction._id,
          $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: null }, { nextCheckAt: { $lte: new Date(now) } }]
        },
        { $set: { lastCheckedAt: new Date(now), nextCheckAt: new Date(now + (transaction.status === successStatus ? 60 * 1000 : nextInterval(transaction, now))) }, $inc: { checkAttempts: 1 } },
        { new: true }
      );
      if (!claimed) return null;
      const updated = claimed.status === successStatus && !claimed.reconciliationMismatch
        ? claimed
        : await service.checkTransactionStatus(claimed[referenceField]);
      const subscription = await paymentMiddleware.processTransactionUpdate(updated);
      return { transaction: updated, subscription };
    } catch (error) {
      // One outage or malformed old purchase must not stop other paying users.
      console.error(`[${label}Verification] Recovery failed:`, error.code || error.name || 'ERROR');
      return null;
    }
  }

  async function scan(userId) {
    const now = Date.now();
    const filter = candidateQuery(userId, now);
    if (userId) filter.$and = [{ $or: [
      { nextCheckAt: { $exists: false } }, { nextCheckAt: null }, { nextCheckAt: { $lte: new Date(now) } }
    ] }];
    const candidates = await Model.find(filter)
      .sort(userId ? { createdAt: -1 } : { nextCheckAt: 1, createdAt: 1 }).limit(userId ? 3 : BATCH_SIZE);
    const selected = candidates.filter(transaction => shouldCheckNow(transaction, now));
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < selected.length) {
        const index = cursor++;
        results[index] = await verifyOne(selected[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));
    return { scanned: candidates.length, checked: selected.length, succeeded: results.filter(result => result?.subscription).length, results };
  }

  return {
    async verifyUserPendingTransactions(userId) { return (await scan(userId)).results; },
    verifyAllPendingTransactions() {
      if (!running) running = scan().finally(() => { running = null; });
      return running;
    },
    // Retain the old export without guessing that an unconfirmed charge expired.
    async expireOldPending() { return 0; },
    shouldCheckNow
  };
}

module.exports = { createRecovery, shouldCheckNow, waitForUserRecovery, MAX_AGE_MS };
