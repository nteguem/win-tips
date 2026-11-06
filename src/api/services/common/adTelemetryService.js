'use strict';
const { contract, normalizeBatch, summaryFilters, summaryPipeline } = require('../../../core/adTelemetry');

function createTelemetryService({ model, now = Date.now, storageTimeoutMs = 3500, maxInFlight = 8 } = {}) {
  // Lazy load avoids connecting to Mongo or opening any queue at module import.
  const storage = () => model || require('../../models/common/AdTelemetryEvent');
  let indexes;
  async function preparedStorage() {
    const target = storage();
    if (typeof target.createIndexes === 'function') {
      // An upsert alone is not a concurrency lock until the unique index exists.
      // Keep this promise shared and retry an index-build failure later.
      indexes ||= target.createIndexes().catch(error => { indexes = null; throw error; });
      await indexes;
    }
    return target;
  }
  let inFlight = 0;
  async function bounded(operation) {
    if (inFlight >= maxInFlight) throw new Error('Telemetry storage busy');
    inFlight++;
    // An HTTP deadline cannot guarantee cancellation of an ambiguous Mongo
    // write. Hold its admission slot until the driver actually settles; retries
    // retain the same event IDs and the unique index prevents double counting.
    const pending = Promise.resolve().then(operation);
    pending.then(() => { inFlight--; }, () => { inFlight--; });
    let timer;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Telemetry storage timeout')), storageTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  return {
    async ingest({ appId, body, rawBytes }) {
      const instant = now();
      const batch = normalizeBatch(body, instant, rawBytes);
      if (!batch.events.length) return { accepted: 0, duplicates: batch.duplicates, rejected: batch.rejected };
      const receivedAt = new Date(instant);
      const expiresAt = new Date(instant + contract.retentionDays * 86400000);
      const operations = batch.events.map(event => ({ updateOne: {
        filter: { appId, eventId: event.eventId },
        update: { $setOnInsert: { ...event, appId, receivedAt, expiresAt } }, upsert: true
      } }));
      let inserted;
      try {
        const result = await bounded(async () => (await preparedStorage()).bulkWrite(operations, { ordered: false, maxTimeMS: 3000 }));
        inserted = result.upsertedCount || 0;
      } catch (error) {
        // Racing requests with the same IDs can produce duplicate-key errors.
        // Any other/unknown/ambiguous error is retried with the original IDs.
        const errors = error.writeErrors;
        if (!Array.isArray(errors) || !errors.length || errors.some(item => item.code !== 11000) ||
            error.writeConcernErrors?.length) throw error;
        inserted = error.result?.upsertedCount ?? error.result?.result?.nUpserted ?? 0;
      }
      return { accepted: inserted, duplicates: batch.duplicates + batch.events.length - inserted, rejected: batch.rejected };
    },
    async summary({ query, appId, fixedAppId }) {
      const filters = summaryFilters(query, { appId, fixedAppId, now: now() });
      const rows = await bounded(async () => (await preparedStorage()).aggregate(summaryPipeline(filters.match)).option({ maxTimeMS: 3000 }));
      return { schemaVersion: contract.schemaVersion, from: filters.from.toISOString(),
        toExclusive: filters.toExclusive.toISOString(), retentionDays: contract.retentionDays,
        source: 'unattested_mobile_events', revenueSource: contract.revenueSource,
        audienceMetrics: contract.audienceMetrics, maximumGroupsPerSection: 200,
        groupsMayBeTruncated: true, sections: rows[0] || {} };
    }
  };
}
module.exports = { createTelemetryService };
