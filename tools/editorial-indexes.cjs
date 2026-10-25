#!/usr/bin/env node
// Explicit, bounded schema provisioning. No application/job imports.
const COLLECTION = 'editorialitems';
const { REVIEW_IDENTITY_INDEX, matchesIndexDefinition } = require('../src/api/services/common/editorialIndexIdentity');
const SPECS = [
  { key: { categoryId: 1, source: 1, editionDate: 1, sourceId: 1 }, name: 'editorial_identity_unique', unique: true },
  { key: { categoryId: 1, source: 1, editionDate: 1 }, name: 'editorial_duo_one_per_day', unique: true, partialFilterExpression: { source: 'rdj_football_duo' } },
  { key: { editionDate: -1, categoryId: 1, isPublished: 1, startsAtUtc: 1 }, name: 'editorial_feed_by_date' },
  { key: { categoryId: 1, isPublished: 1, editionDate: -1 }, name: 'editorial_library_available_dates' },
];
const COLLECTIONS = {
  [COLLECTION]: SPECS,
  editorialcopies: [require('../src/api/services/common/editorialCopyStorage').INDEX],
  editorialreviews: [
    REVIEW_IDENTITY_INDEX,
    { key: { categoryId: 1, editionDate: 1, createdAt: -1, _id: -1 }, name: 'editorial_review_edition_recent' },
  ],
  // This one per-edition document serializes Duo/Goals reservations in the
  // same transaction as their items. Never create it from a request/job.
  editorialticketstates: [
    { key: { editionDate: 1 }, name: 'editorial_ticket_edition_unique', unique: true },
  ],
  editorialnotifications: [
    { key: { appId: 1, categoryId: 1, source: 1, editionDate: 1 }, name: 'editorial_notification_identity_unique', unique: true },
    { key: { status: 1, nextAttemptAt: 1, leaseUntil: 1 }, name: 'editorial_notification_pending' },
  ],
  // The existing push gateway requires its original unique delivery key too.
  // Provisioning is explicit here; ordinary reads/drains never create indexes.
  pushdeliveries: [ { key: { msgId: 1 }, name: 'msgId_1', unique: true } ],
};
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function inspectCollection(db, collection, specs) {
  let current = [];
  try { current = await db.collection(collection).listIndexes().toArray(); }
  catch (error) { if (error.code !== 26) throw error; } // absent namespace
  const missing = [], conflicts = [];
  for (const spec of specs) {
    const named = current.find(index => index.name === spec.name);
    if (named && !matchesIndexDefinition(named, spec)) conflicts.push(spec.name);
    else if (!named) {
      if (current.some(index => sameKey(index.key, spec.key))) conflicts.push(spec.name);
      else missing.push(spec.name);
    }
  }
  return { collection, ready: missing.length === 0 && conflicts.length === 0, missing, conflicts };
}
async function inspect(db, { onlyCopies = false } = {}) {
  const collections = await Promise.all(Object.entries(COLLECTIONS).filter(([name]) => !onlyCopies || name === 'editorialcopies').map(([collection, specs]) => inspectCollection(db, collection, specs)));
  return { ready: collections.every(result => result.ready), collections,
    missing: collections.flatMap(result => result.missing), conflicts: collections.flatMap(result => result.conflicts) };
}

async function provision(db, { apply = false, intent = false, onlyCopies = false } = {}) {
  if (apply && !intent) { const error = new Error('Explicit --confirm-editorial-indexes required'); error.code = 'INTENT_REQUIRED'; throw error; }
  const before = await inspect(db, { onlyCopies });
  if (!apply || before.ready) return { ...before, readOnly: true, created: [] };
  if (before.conflicts.length) { const error = new Error('Existing indexes require operator review; no index is dropped'); error.code = 'INDEX_CONFLICT'; throw error; }
  const created = [];
  for (const result of before.collections.filter(result => !result.ready)) {
    try { await db.createCollection(result.collection); }
    catch (error) { if (error.code !== 48) throw error; } // already exists
    for (const spec of COLLECTIONS[result.collection].filter(candidate => result.missing.includes(candidate.name))) {
      const { key, ...options } = spec;
      await db.collection(result.collection).createIndex(key, options);
      created.push(spec.name);
    }
  }
  return { ...await inspect(db, { onlyCopies }), readOnly: false, created };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = ['--check', '--apply', '--confirm-editorial-indexes', '--copies-only'];
  if (args.some(arg => !allowed.includes(arg)) || (args.includes('--check') && args.includes('--apply'))) throw Object.assign(new Error('Invalid arguments'), { code: 'ARGUMENTS' });
  const apply = args.includes('--apply'), intent = args.includes('--confirm-editorial-indexes');
  if (apply && !intent) throw Object.assign(new Error('Intent flag required'), { code: 'INTENT_REQUIRED' });
  const fs = require('fs'), path = require('path'), mongoose = require('mongoose'), dotenv = require('dotenv');
  const envPath = path.join(__dirname, '..', '.env');
  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const uri = process.env.MONGO_URI || env.MONGO_URI || 'mongodb://localhost:27017/wintips';
  const connection = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000, maxPoolSize: 1 }).asPromise();
  try {
    const result = await provision(connection.db, { apply, intent, onlyCopies: args.includes('--copies-only') });
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 2;
  } finally { await connection.close(); }
}

if (require.main === module) main().catch(error => {
  // Mongo errors can contain connection strings or data; never print them.
  console.error(JSON.stringify({ success: false, errorCode: String(error.code || error.name || 'ERROR') }));
  process.exitCode = 1;
});
module.exports = { inspect, provision, COLLECTION, SPECS, COLLECTIONS };
