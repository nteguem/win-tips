#!/usr/bin/env node
'use strict';

// Explicit cosmetic maintenance only. Never load application startup, models,
// API routes, schedulers, credentials for cloud providers or push transports.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const { editionDateFor } = require(path.join(root, 'src/api/services/common/editorialCalendar'));
const { sourceByKey, validateCategorySource } = require(path.join(root, 'src/api/services/common/editorialSources'));
const { boundTeaser, teaserForOperations } = require(path.join(root, 'src/api/services/common/couponTeaser'));

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => String(value);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => sha(canonical(JSON.parse(JSON.stringify(value))));

function currentDate(requested, now = new Date()) {
  const today = editionDateFor(now);
  if (requested !== undefined && requested !== today) fail('CURRENT_PARIS_EDITION_REQUIRED');
  return today;
}
function assertDatabase(db) {
  if (!db || db.databaseName !== 'wintips') fail('WINTIPS_DATABASE_REQUIRED');
}
function copyKey(source, date) { return { _id: `wintips:${source}:${date}`, appId: 'wintips', source, editionDate: date, initialized: true }; }

async function mappedCategories(db, session) {
  const rows = await db.collection('categories').find({ isActive: true, catalogueArchived: { $ne: true }, editorialSource: { $type: 'string' } },
    { ...(session ? { session } : {}), maxTimeMS: 5000 }).limit(101).toArray();
  if (rows.length > 100) fail('CATEGORY_REVIEW_LIMIT');
  return rows.filter(row => {
    const source = sourceByKey(row.editorialSource);
    if (!source) return false;
    try { return !!validateCategorySource(row.editorialSource, row.isVip); }
    catch (_) { fail('CATEGORY_SOURCE_ACCESS_MISMATCH'); }
  });
}

async function sourceState(db, source, date, categories, session) {
  const mappings = categories.filter(category => category.editorialSource === source);
  if (!mappings.length || !sourceByKey(source)) fail('SOURCE_NOT_ACTIVELY_MAPPED');
  const options = { ...(session ? { session } : {}), maxTimeMS: 5000 };
  const query = { source, editionDate: date, categoryId: { $in: mappings.map(category => category._id) } };
  // The same function runs inside a transaction: never parallelize operations
  // on its session, even though exporting does not need a write transaction.
  const rows = await db.collection('editorialitems').find(query, options).limit(301).toArray();
  const record = await db.collection('editorialcopies').findOne(copyKey(source, date), options);
  if (!rows.length || rows.length > 300 || rows.some(row => row.isPublished !== true)) fail('SOURCE_NOT_PUBLISHED');
  if (!record || !Number.isSafeInteger(record.revision)) fail('INITIALIZED_COPY_REQUIRED');
  const unique = new Map(), contexts = new Map();
  for (const row of rows) {
    const item = row.payload;
    if (row.source !== source || row.editionDate !== date || typeof row.sourceId !== 'string'
        || item?.source !== source || item?.editionDate !== date || item?.sourceId !== row.sourceId
        || row.contentHash !== sha(JSON.stringify(item))) fail('SOURCE_CONTENT_BINDING_INVALID');
    const previous = unique.get(row.sourceId);
    if (previous && previous.contentHash !== row.contentHash) fail('SOURCE_ALIAS_CONTEXT_CONFLICT');
    unique.set(row.sourceId, row);
    const category = id(row.categoryId);
    if (!contexts.has(category)) contexts.set(category, []);
    contexts.get(category).push([row.sourceId, row.contentHash]);
  }
  const signatures = [...contexts.values()].map(values => hash(values.sort((a, b) => a[0].localeCompare(b[0]))));
  if (new Set(signatures).size !== 1 || unique.size > 50) fail('SOURCE_CATEGORY_CONTEXT_CONFLICT');
  const items = [...unique.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(row => row.payload);
  return { source, editionDate: date, items, rows, record, query };
}

function protectedSnapshot(state) {
  const { couponTeaser, ...record } = state.record;
  return hash({ record, rows: [...state.rows].sort((a, b) => id(a._id).localeCompare(id(b._id))) });
}

async function exportBatches(db, requested, { now = () => new Date() } = {}) {
  assertDatabase(db);
  const date = currentDate(requested, now()), categories = await mappedCategories(db);
  const batches = [], skipped = [];
  for (const source of [...new Set(categories.map(category => category.editorialSource))].sort()) {
    let state;
    try { state = await sourceState(db, source, date, categories); }
    catch (error) {
      if (error.code === 'SOURCE_NOT_PUBLISHED' || error.code === 'INITIALIZED_COPY_REQUIRED') {
        skipped.push({ source, reason: error.code }); continue;
      }
      throw error;
    }
    if (boundTeaser(state.record, state.rows)) { skipped.push({ source, reason: 'READY' }); continue; }
    batches.push({ source, editionDate: date, items: state.items });
  }
  currentDate(date, now());
  return { date, batches, skipped, databaseMutation: false, notificationsSent: false };
}

function checkedInput(input, now) {
  if (!exact(input, ['date', 'teasers']) || !Array.isArray(input.teasers) || !input.teasers.length || input.teasers.length > 7) fail('INVALID_MAINTENANCE_INPUT');
  currentDate(input.date, now);
  const seen = new Set();
  for (const row of input.teasers) {
    if (!exact(row, ['source', 'editionDate', 'couponTeaser']) || !sourceByKey(row.source)
        || row.editionDate !== input.date || seen.has(row.source)) fail('INVALID_MAINTENANCE_INPUT');
    seen.add(row.source);
  }
  return input;
}

async function applyTeasers(db, client, input, { now = () => new Date() } = {}) {
  assertDatabase(db); checkedInput(input, now());
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') fail('TRANSACTIONS_REQUIRED');
  const session = client.startSession();
  let results;
  try {
    await session.withTransaction(async () => {
      results = [];
      currentDate(input.date, now());
      const categories = await mappedCategories(db, session);
      const pending = [];
      // Validate every declared source before the first cosmetic write.
      for (const row of input.teasers) {
        const state = await sourceState(db, row.source, input.date, categories, session);
        if (boundTeaser(state.record, state.rows)) {
          results.push({ source: row.source, status: 'already_ready' }); continue;
        }
        const batch = { source: row.source, editionDate: input.date, couponTeaser: row.couponTeaser };
        const operations = state.items.map(payload => ({ updateOne: { update: { $set: { payload } } } }));
        const checked = teaserForOperations(batch, operations);
        if (!checked || !boundTeaser({ ...state.record, couponTeaser: checked }, state.rows)) fail('COUPON_TEASER_BINDING_INVALID');
        pending.push({ state, checked, before: protectedSnapshot(state) });
      }
      for (const { state, checked, before } of pending) {
        currentDate(input.date, now());
        const filter = { ...copyKey(state.source, input.date), revision: state.record.revision,
          couponTeaser: Object.hasOwn(state.record, 'couponTeaser') ? { $eq: state.record.couponTeaser } : { $exists: false } };
        const changed = await db.collection('editorialcopies').updateOne(filter,
          { $set: { couponTeaser: checked } }, { session });
        if (changed.matchedCount !== 1) {
          results.push({ source: state.source, status: 'cas_conflict' }); continue;
        }
        const after = await sourceState(db, state.source, input.date, categories, session);
        if (protectedSnapshot(after) !== before || !boundTeaser(after.record, after.rows)) fail('PROTECTED_STATE_CHANGED');
        results.push({ source: state.source, status: 'updated', description: checked.body,
          protectedStateSha256: before, protectedStatePreserved: true });
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
  } finally { await session.endSession(); }
  return { date: input.date, appId: 'wintips', updated: results.filter(row => row.status === 'updated').length,
    results, sourceItemsModified: false, frozenCopyModified: false, notificationsSent: false };
}

function parseArgs(argv, now = new Date()) {
  if (argv[0] === '--export' && argv.length <= 2) return { mode: 'export', date: currentDate(argv[1], now) };
  if (argv[0] === '--apply' && argv.length === 2 && argv[1] && !argv[1].startsWith('--')) return { mode: 'apply', file: argv[1] };
  fail('USE_EXPORT_OR_APPLY_FILE');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const envFile = path.join(root, '.env');
  const stored = fs.existsSync(envFile) ? require('dotenv').parse(fs.readFileSync(envFile)) : {};
  const value = key => process.env[key] ?? stored[key];
  if (value('APP_ID') && value('APP_ID') !== 'wintips') fail('WINTIPS_APP_REQUIRED');
  const uri = value('MONGO_URI');
  if (!uri) fail('DATABASE_CONFIGURATION_REQUIRED');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 10000, appName: 'wintips-coupon-teaser-maintenance' });
  try {
    await client.connect();
    const db = client.db(); assertDatabase(db);
    let output;
    if (options.mode === 'export') output = await exportBatches(db, options.date);
    else {
      const stat = fs.statSync(options.file);
      if (!stat.isFile() || stat.size > 100000) fail('INVALID_MAINTENANCE_INPUT');
      const input = JSON.parse(fs.readFileSync(options.file, 'utf8'));
      output = await applyTeasers(db, client, input);
    }
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally { await client.close(); }
}

if (require.main === module) main().catch(error => {
  // Provider/Mongo messages and connection details are deliberately excluded.
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'MAINTENANCE_FAILED';
  process.stderr.write(JSON.stringify({ success: false, code, notificationsSent: false }) + '\n');
  process.exitCode = 1;
});
module.exports = { currentDate, parseArgs, exportBatches, applyTeasers, checkedInput, protectedSnapshot, main };
