// Run with node --test tests/editorial.node-test.cjs; independent of Jest/DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const { validateCategorySource, validatePublisherUrl } = require('../src/api/services/common/editorialSources');
const workerAuth = require('../src/api/middlewares/common/editorialWorkerAuth');

const today = '2026-10-23';
const clock = () => new Date(`${today}T08:00:00Z`);
const clone = value => JSON.parse(JSON.stringify(value));
const user = { _id: 'reader' };
const source = 'rdj_petit_journal';
const category = (overrides = {}) => ({ _id: 'a'.repeat(24), name: { fr: 'Journal', en: 'Journal' }, description: { fr: 'Edition', en: 'Edition' }, icon: 'J', isVip: false, isActive: true, editorialSource: source, ...overrides });
function match(overrides = {}) {
  return { sourceId: '12345', sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-journal-du-23-octobre.html',
    kind: 'match', title: { fr: 'Equipe A contre Equipe B' }, summary: { fr: 'Deux equipes et leur forme recente.' },
    startsAtUtc: `${today}T19:00:00Z`, sport: { key: 'football', name: 'Football' }, competition: { name: 'Coupe' },
    teams: { home: { name: 'Equipe A' }, away: { name: 'Equipe B' } },
    analysis: { fr: [{ heading: 'Le contexte', paragraphs: ['Analyse originale verifiee.'] }] },
    selection: { label: { fr: 'Equipe A ou nul' }, odds: 1.5 }, status: 'upcoming', ...overrides };
}
function horse() {
  return match({ sourceId: '2026-10-23-R1C4', sourceUrl: 'https://www.ruedesjoueurs.com/turf/pronostic-turf/course/23-10-2026/R1/C4/prix-orionis.html', kind: 'horse_racing',
    teams: undefined, sport: { key: 'horse_racing', name: 'Courses hippiques' },
    race: { meetingNumber: 1, raceNumber: 4, name: 'Prix Orionis', racecourse: 'Vincennes', discipline: 'Attele', distanceMeters: 2850, runnersCount: 2,
      runners: [{ number: 1, name: 'Cheval A', odds: 3.5 }, { number: 2, name: 'Cheval B' }] },
    selection: { label: { fr: 'Selection RDJ' }, odds: null, betType: 'Selection editoriale', orderedNumbers: [2, 1] } });
}
function combine() {
  const leg = n => match({ source: 'rdj_football_combine', sourceId: String(n), sourceUrl: `https://www.ruedesjoueurs.com/pronostic/equipe-a-equipe-b-${n}.html`, selection: { label: { fr: 'Equipe A ou nul' }, odds: null } });
  return match({ sourceId: '74799', sourceUrl: 'https://www.ruedesjoueurs.com/actualites/paris-sportifs/74799-combine-23-10-2026.html', kind: 'combine', teams: undefined,
    legs: [leg(12345), leg(12346)], selection: { label: { fr: 'Combine de deux rencontres' }, odds: null, totalOdds: 2.4 } });
}
function memory(categories = [category()]) {
  const rows = [];
  const state = { categories, rows, writes: 0, access: false, subscriber: false, unlocked: false };
  const repository = {
    categories: async () => state.categories,
    category: async key => state.categories.find(c => String(c._id) === String(key)),
    items: async (ids, date) => rows.filter(row => ids.map(String).includes(String(row.categoryId)) && row.editionDate === date),
    item: async key => rows.find(row => row._id === key),
    hasCategoryAccess: async () => state.access,
    hasAnySubscription: async () => state.subscriber,
    gate: async (reader, cat, subscriber) => ({ gated: !!cat.accessGate && !subscriber, locked: !!cat.accessGate && !subscriber && !(reader && state.unlocked), offers: [{ adsRequired: 1, durationMinutes: 60 }], state: null, unlockCount: 0 }),
    upsertBatch: async operations => {
      state.writes++;
      let inserted = 0, matched = 0;
      for (const { updateOne: operation } of operations) {
        const row = rows.find(r => Object.entries(operation.filter).every(([key, value]) => String(r[key]) === String(value)));
        if (row) { Object.assign(row, clone(operation.update.$set)); matched++; }
        else { rows.push({ _id: (rows.length + 1).toString(16).padStart(24, '0'), ...clone(operation.filter), ...clone(operation.update.$setOnInsert), ...clone(operation.update.$set) }); inserted++; }
      }
      return { upsertedCount: inserted, matchedCount: matched };
    },
  };
  return { state, service: createEditorialService({ repository, clock, importEnabled: () => true, requireEnglish: () => false }), repository };
}
const batch = (items = [match()], sourceKey = source) => ({ source: sourceKey, editionDate: today, items });
function assertNoPicks(value) {
  for (const key of ['analysis', 'selection', 'odds', 'totalOdds', 'orderedNumbers', 'payload', 'contentHash', 'notificationState']) {
    assert.equal(new RegExp(`"${key}"\\s*:`).test(JSON.stringify(value)), false, key);
  }
}

test('category source access is checked; legacy null is retained', () => {
  assert.equal(validateCategorySource(null, true), null);
  assert.equal(validateCategorySource(source, false), source);
  assert.throws(() => validateCategorySource(source, true));
  assert.throws(() => validateCategorySource(source, 'false'));
  assert.throws(() => validateCategorySource('unknown', false));
});
test('worker channel fails closed and never accepts an empty/unconfigured token', () => {
  const old = process.env.WINTIPS_EDITORIAL_WORKER_TOKEN;
  const response = () => ({ code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  try {
    delete process.env.WINTIPS_EDITORIAL_WORKER_TOKEN;
    let res = response(), calls = 0;
    workerAuth({ headers: {} }, res, () => calls++); assert.equal(res.code, 503); assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
    process.env.WINTIPS_EDITORIAL_WORKER_TOKEN = 'x'.repeat(48);
    res = response(); workerAuth({ headers: { authorization: 'Bearer wrong' } }, res, () => calls++); assert.equal(res.code, 401); assert.equal(res.body.error.code, 'AUTH_INVALID_TOKEN');
    res = response(); workerAuth({ headers: { authorization: `Bearer ${'x'.repeat(48)}` } }, res, () => calls++); assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.WINTIPS_EDITORIAL_WORKER_TOKEN; else process.env.WINTIPS_EDITORIAL_WORKER_TOKEN = old; }
});
test('imports are explicitly disabled by default, including with a valid payload', async () => {
  const { state, repository } = memory();
  const service = createEditorialService({ repository, clock });
  await assert.rejects(service.importBatch(batch()), { statusCode: 403 });
  assert.equal(state.writes, 0);
  assert.equal((await service.workerConfig()).notificationsEnabled, false);
});
test('the entire batch is validated before the DAL receives any write', async () => {
  const { service, state } = memory();
  await assert.rejects(service.importBatch(batch([match(), match({ sourceId: '999', selection: { label: { fr: 'X' }, odds: NaN } })])));
  assert.equal(state.writes, 0);
  await assert.rejects(service.importBatch(batch([match(), match()])));
  assert.equal(state.writes, 0);
});
test('stale/future editions and a different publisher match day cannot be published as today', () => {
  for (const date of ['2026-10-22', '2026-10-24', '2026-02-30']) assert.throws(() => validateBatch({ ...batch(), editionDate: date }, clock()));
  assert.throws(() => validateBatch(batch([match({ startsAtUtc: '2026-10-22T19:00:00Z' })]), clock()));
  assert.throws(() => validateBatch(batch([match({ startsAtUtc: '2026-10-23T19:00:00' })]), clock()));
  assert.equal(validateBatch(batch([match({ startsAtUtc: '2026-10-23T21:00:00+02:00' })]), clock()).items[0].startsAtUtc, '2026-10-23T19:00:00.000Z');
  assert.throws(() => validateBatch(batch([match({ startsAtUtc: null })]), clock()));
});
test('publisher URLs are exact, canonical and cannot smuggle another host or credentials', () => {
  for (const url of ['http://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html', 'https://www.ruedesjoueurs.com.evil.test/paris-sportifs/le-petit-journal.html', 'https://secret@www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html', 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html?redirect=https://evil.test', 'https://www.ruedesjoueurs.com/actualites/paris-sportifs.html']) assert.throws(() => validatePublisherUrl(url, source));
  assert.throws(() => validateBatch(batch([match({ sourceId: { $ne: null } })]), clock()));
  assert.throws(() => validateBatch({ ...batch(), categoryId: 'injected' }, clock()));
});
test('reimports upsert the same identity and preserve notification delivery state', async () => {
  const { service, state } = memory();
  const first = await service.importBatch(batch());
  assert.equal(first.inserted, 1); assert.equal(first.notificationsSent, 0);
  state.rows[0].notificationState = 'sent'; state.rows[0].notificationSentAt = today;
  const second = await service.importBatch(batch([match({ summary: { fr: 'Texte actualise.' } })]));
  assert.equal(second.inserted, 0); assert.equal(second.matched, 1); assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].notificationState, 'sent'); assert.equal(state.rows[0].notificationSentAt, today);
  assert.equal(state.rows[0].payload.summary.fr, 'Texte actualise.');
});
test('an unselected source is ignored and cannot assign itself a category', async () => {
  const { service, state } = memory([category({ editorialSource: null })]);
  const result = await service.importBatch(batch()); assert.equal(result.ignored, true); assert.equal(state.writes, 0);
  assert.equal((await service.workerConfig()).sources.length, 0);
});
test('a free request never includes VIP/disabled/legacy category content', async () => {
  const { service, state } = memory([category(), category({ _id: 'b'.repeat(24), isVip: true, editorialSource: 'rdj_football_analysis' }), category({ _id: 'c'.repeat(24), isActive: false }), category({ _id: 'd'.repeat(24), editorialSource: null })]);
  await service.importBatch(batch());
  const feed = await service.feed(); assert.equal(feed.date, today); assert.equal(feed.categories.length, 1);
  assert.equal(feed.categories[0].id, 'a'.repeat(24)); assert.equal(feed.categories[0].items.length, 1); assertNoPicks(feed);
  assert.equal(state.rows.length, 1);
});
test('anonymous VIP feed is rejected; logged-in teaser contains no protected picks or analysis', async () => {
  const { service } = memory([category({ isVip: true, editorialSource: 'rdj_football_combine' })]);
  await service.importBatch(batch([combine()], 'rdj_football_combine'));
  await assert.rejects(service.feed({ isVip: true }), { statusCode: 401 });
  await assert.rejects(service.feed({ isVip: 'true', user }), { statusCode: 400 });
  const feed = await service.feed({ isVip: true, user });
  assert.equal(feed.categories[0].locked, true); assert.equal(feed.categories[0].items[0].summary, undefined); assertNoPicks(feed);
});
test('VIP entitlement is enforced on analysis independently of feed/query flags', async () => {
  const { service, state } = memory([category({ isVip: true, editorialSource: 'rdj_football_analysis' })]);
  await service.importBatch(batch([match({ sourceUrl: 'https://www.ruedesjoueurs.com/pronostic/equipe-a-equipe-b-12345.html' })], 'rdj_football_analysis'));
  const key = state.rows[0]._id;
  await assert.rejects(service.analysis(key), { statusCode: 401 });
  await assert.rejects(service.analysis(key, { user }), { statusCode: 403 });
  state.access = true;
  assert.equal((await service.analysis(key, { user })).selection.odds, 1.5);
});
test('rewarded-locked free feed and detail stay protected; an active subscriber bypasses the gate', async () => {
  const { service, state } = memory([category({ accessGate: { type: 'ad_reward' } })]);
  await service.importBatch(batch()); const key = state.rows[0]._id;
  const feed = await service.feed(); assert.equal(feed.categories[0].locked, true); assertNoPicks(feed);
  await assert.rejects(service.analysis(key), { statusCode: 401 });
  await assert.rejects(service.analysis(key, { user }), { statusCode: 403 });
  state.unlocked = true; assert.equal((await service.analysis(key, { user })).locked, false);
  state.unlocked = false; state.subscriber = true;
  const subscribed = await service.feed({ user }); assert.equal(subscribed.categories[0].locked, false); assert.equal(subscribed.categories[0].gate, null);
  assert.equal((await service.analysis(key, { user })).locked, false);
});
test('a changed/disabled category invalidates a previously acquired item URL', async () => {
  const { service, state } = memory(); await service.importBatch(batch()); const key = state.rows[0]._id;
  state.categories[0].editorialSource = null; await assert.rejects(service.analysis(key), { statusCode: 404 });
  state.categories[0].editorialSource = source; state.categories[0].isActive = false;
  await assert.rejects(service.analysis(key), { statusCode: 404 });
});
test('FR original is explicit when EN analysis is unavailable; no fake English translation', async () => {
  const { service, state } = memory(); await service.importBatch(batch()); const key = state.rows[0]._id;
  let detail = await service.analysis(key, { lang: 'en' });
  assert.equal(detail.contentLanguage, 'fr'); assert.equal(detail.translationAvailable, false); assert.equal(detail.analysis.en, undefined);
  const translated = match({ title: { fr: 'Match', en: 'Match' }, summary: { fr: 'Forme recente.', en: 'Recent form.' }, selection: { label: { fr: 'Equipe A ou nul', en: 'Team A or draw' }, odds: 1.5 }, analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Texte francais.'] }], en: [{ heading: 'Context', paragraphs: ['Faithful English text.'] }] } });
  await service.importBatch(batch([translated])); detail = await service.analysis(key, { lang: 'en' });
  assert.equal(detail.contentLanguage, 'en'); assert.equal(detail.translationAvailable, true);
});
test('horse selections must point at real unique runner numbers; no total odds are inferred', () => {
  const validated = validateBatch(batch([horse()], 'rdj_turf_quinte'), clock()).items[0];
  assert.deepEqual(validated.selection.orderedNumbers, [2, 1]); assert.equal(validated.selection.totalOdds, null);
  let bad = horse(); bad.selection.orderedNumbers = [99]; assert.throws(() => validateBatch(batch([bad], 'rdj_turf_quinte'), clock()));
  bad = horse(); bad.race.runners[1].number = 1; assert.throws(() => validateBatch(batch([bad], 'rdj_turf_quinte'), clock()));
  bad = horse(); bad.selection.orderedNumbers = []; assert.throws(() => validateBatch(batch([bad], 'rdj_turf_quinte'), clock()));
  bad = horse(); bad.sourceUrl = bad.sourceUrl.replace('23-10-2026', '22-10-2026'); assert.throws(() => validateBatch(batch([bad], 'rdj_turf_quinte'), clock()));
});
test('combined odds are publisher-supplied; missing leg odds stay null and old legs are rejected', () => {
  const item = validateBatch(batch([combine()], 'rdj_football_combine'), clock()).items[0];
  assert.equal(item.selection.totalOdds, 2.4); assert.equal(item.legs[0].selection.odds, null);
  const stale = combine(); stale.legs[1].startsAtUtc = '2026-10-21T19:00:00Z';
  assert.throws(() => validateBatch(batch([stale], 'rdj_football_combine'), clock()));
});

function loadSyncController(editorialSource, externalSources = []) {
  let writes = 0;
  const doc = { _id: 'ticket', category: 'category', editorialSource, externalSources };
  const query = () => ({ select() { return this; }, lean: async () => doc });
  const mocks = {
    '../../services/common/ticketService': { createTicket: async () => { writes++; }, updateTicket: async () => { writes++; } },
    '../../services/common/predictionService': { addPredictionsToTicket: async () => { writes++; } },
    '../../models/common/Category': { findOne: () => ({ lean: async () => doc }), findById: query },
    '../../models/common/Ticket': { findById: query },
    '../../services/common/editorialLegacyBridge': require('../src/api/services/common/editorialLegacyBridge'),
    '../../../utils/responseFormatter': { formatSuccess: (res, body) => res.json(body), formatError: () => { throw new Error('Unexpected sync error'); } },
  };
  const exports = {};
  const file = path.join(__dirname, '../src/api/controllers/common/internalSyncController.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require: name => { if (!(name in mocks)) throw new Error(name); return mocks[name]; } }, { filename: file });
  return { controller: exports, writes: () => writes };
}
test('selected editorial categories pause all three legacy incoming sync mutations', async () => {
  const { controller, writes } = loadSyncController(source);
  for (const operation of ['createTicket', 'bulkPredictions', 'publishTicket']) {
    const req = { params: { id: 'ticket' }, body: { sourceAppId: 'bigwin', sourceCategoryId: 'cdj', title: 'Legacy', date: today, predictions: [{}] } };
    const res = { json(body) { assert.equal(body.data.ignored, true); assert.equal(body.data.reason, 'editorial_source_selected'); return body; } };
    await controller[operation](req, res);
  }
  assert.equal(writes(), 0);
});

function categoryController(current) {
  const calls = [];
  const service = { getCategoryById: async () => current,
    createCategory: async data => { calls.push(data); return { formatForLanguage: () => data }; },
    updateCategory: async (key, data) => { calls.push(data); return { formatForLanguage: () => data }; } };
  const module = { exports: {} };
  const mocks = {
    '../../services/common/categoryService': service,
    '../../services/common/editorialSources': require('../src/api/services/common/editorialSources'),
    '../../../utils/responseFormatter': { formatSuccess: (res, data) => res.json(data), formatError: () => { throw new Error('Unexpected category error'); } },
  };
  const file = path.join(__dirname, '../src/api/controllers/common/categoryController.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, console, require: key => { if (!(key in mocks)) throw new Error(key); return mocks[key]; } });
  return { controller: module.exports, calls };
}
function response() { return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
test('category create/update reject incompatible editorial access and preserve legacy mappings', async () => {
  let pair = categoryController(category()), res = response();
  await pair.controller.createCategory({ body: { name: { fr: 'Test', en: 'Test' }, isVip: false, editorialSource: 'rdj_football_analysis' } }, res);
  assert.equal(res.code, 400); assert.equal(pair.calls.length, 0);
  pair = categoryController(category({ isVip: true, editorialSource: 'rdj_football_analysis', externalSources: [{ system: 'bigwin', appId: 'bigwin', categoryId: 'abc' }] }));
  res = response(); await pair.controller.updateCategory({ params: { id: 'category' }, body: { isVip: false } }, res);
  assert.equal(res.code, 400); assert.equal(pair.calls.length, 0);
  res = response(); await pair.controller.updateCategory({ params: { id: 'category' }, body: { isVip: false, editorialSource: null } }, res);
  assert.equal(res.code, 200); assert.equal(pair.calls[0].editorialSource, null);
  assert.equal('externalSources' in pair.calls[0], false);
});
test('nested Mongo operators cannot bypass editorial-source validation', async () => {
  const { controller, calls } = categoryController(category({ editorialSource: null }));
  for (const body of [{ $set: { editorialSource: 'rdj_petit_journal' } }, { $rename: { name: 'editorialSource' } }]) {
    const res = response(); await controller.updateCategory({ params: { id: 'category' }, body }, res);
    assert.equal(res.code, 400); assert.equal(calls.length, 0);
  }
});
test('new source writes and edits to editorial categories require admin, without altering legacy permissions', async () => {
  const handlers = {}, module = { exports: {} };
  let protectedCalls = 0, nextCalls = 0, currentSource = null;
  const router = { route(route) { return { get() { return this; }, post(...args) { handlers[`POST${route}`] = args[0]; return this; }, put(...args) { handlers[`PUT${route}`] = args[0]; return this; }, delete(...args) { handlers[`DELETE${route}`] = args[0]; return this; } }; } };
  const mocks = {
    express: { Router: () => router },
    '../../controllers/common/categoryController': {},
    '../../middlewares/admin/adminAuth': { protect: (req, res, next) => { protectedCalls++; next(); } },
    '../../services/common/editorialSources': require('../src/api/services/common/editorialSources'),
    '../../models/common/Category': { findById: () => ({ select() { return this; }, lean: async () => ({ editorialSource: currentSource }) }) },
  };
  const file = path.join(__dirname, '../src/api/routes/admin/categoryRoutes.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: key => { if (!(key in mocks)) throw new Error(key); return mocks[key]; } });
  const run = req => new Promise((resolve, reject) => handlers['PUT/:id'](req, {}, error => { if (error) reject(error); else { nextCalls++; resolve(); } }));
  await run({ params: { id: 'legacy' }, body: { name: 'Legacy' } }); assert.equal(protectedCalls, 0);
  await run({ params: { id: 'legacy' }, body: { editorialSource: source } }); assert.equal(protectedCalls, 1);
  await run({ params: { id: 'legacy' }, body: { $rename: { name: 'editorialSource' } } }); assert.equal(protectedCalls, 2);
  currentSource = source; await run({ params: { id: 'selected' }, body: { name: 'New name' } }); assert.equal(protectedCalls, 3); assert.equal(nextCalls, 4);
});

test('the real DAL refuses writes until the exact unique identity index is explicitly provisioned', async () => {
  let indexes = [], writes = 0;
  const item = { collection: { listIndexes: () => ({ toArray: async () => indexes }) }, bulkWrite: async () => { writes++; return { upsertedCount: 1 }; } };
  const module = { exports: {} };
  const mocks = {
    '../../models/common/Category': {}, '../../models/common/EditorialItem': item,
    '../user/subscriptionService': {}, './accessGateService': {},
    './editorialSources': require('../src/api/services/common/editorialSources'),
  };
  const file = path.join(__dirname, '../src/api/services/common/editorialRepository.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: key => { if (!(key in mocks)) throw new Error(key); return mocks[key]; } });
  const repository = module.exports;
  await assert.rejects(repository.upsertBatch([]), { statusCode: 503 }); assert.equal(writes, 0);
  indexes = [{ name: 'editorial_identity_unique', unique: false, key: { categoryId: 1, source: 1, editionDate: 1, sourceId: 1 } }];
  await assert.rejects(repository.upsertBatch([]), { statusCode: 503 }); assert.equal(writes, 0);
  indexes[0].unique = true;
  await repository.upsertBatch([]); assert.equal(writes, 1);
});

test('new route bootstrap wires admin, worker and optional-user guards without startup/DB imports', () => {
  const guards = { admin() {}, worker() {}, optionalUser() {} };
  const controller = require('../src/api/controllers/common/editorialController');
  function load(relative) {
    const calls = [], router = {};
    for (const method of ['use', 'get', 'post']) router[method] = (...args) => { calls.push({ method, args }); return router; };
    const module = { exports: {} };
    const mocks = { express: { Router: () => router },
      '../../middlewares/admin/adminAuth': { protect: guards.admin },
      '../../middlewares/user/userAuth': { optional: guards.optionalUser },
      '../../middlewares/common/editorialWorkerAuth': guards.worker,
      '../../controllers/common/editorialController': controller };
    const file = path.join(__dirname, '../src/api/routes', relative);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: key => { if (!(key in mocks)) throw new Error(`Unexpected bootstrap dependency: ${key}`); return mocks[key]; } });
    return calls;
  }
  const admin = load('admin/editorialRoutes.js'), worker = load('common/editorialWorkerRoutes.js'), reader = load('common/editorialRoutes.js');
  assert.equal(admin[0].args[0], guards.admin); assert.equal(admin[1].args[0], '/sources');
  assert.equal(worker[0].args[0], guards.worker); assert.deepEqual(worker.slice(1).map(call => call.args[0]), ['/config', '/import', '/notifications/drain']);
  assert.equal(reader[0].args[0], guards.optionalUser); assert.deepEqual(reader.slice(1).map(call => call.args[0]), ['/feed', '/items/:id/analysis']);
  const index = fs.readFileSync(path.join(__dirname, '../src/api/routes/index.js'), 'utf8');
  for (const mount of ['/admin/editorial', '/internal/editorial', '/editorial']) assert.equal(index.includes(`router.use('${mount}'`), true);
});

test('index CLI defaults to read-only, requires explicit intent and never drops conflicts', async () => {
  const { provision, SPECS } = require('../tools/editorial-indexes.cjs');
  let current = {}, mutations = 0;
  const db = { collection: name => ({ listIndexes: () => ({ toArray: async () => current[name] || [] }), createIndex: async (key, options) => { mutations++; (current[name] ||= []).push({ key, ...options }); } }), createCollection: async () => { mutations++; } };
  const check = await provision(db); assert.equal(check.readOnly, true); assert.equal(check.ready, false); assert.equal(mutations, 0);
  await assert.rejects(provision(db, { apply: true }), { code: 'INTENT_REQUIRED' }); assert.equal(mutations, 0);
  current = { editorialitems: [{ name: SPECS[0].name, key: { wrong: 1 } }] };
  await assert.rejects(provision(db, { apply: true, intent: true }), { code: 'INDEX_CONFLICT' }); assert.equal(mutations, 0);
  current = {}; const applied = await provision(db, { apply: true, intent: true }); assert.equal(applied.ready, true); assert.equal(mutations, 8);
  const repeat = await provision(db, { apply: true, intent: true }); assert.equal(repeat.readOnly, true); assert.equal(mutations, 8);
});

test('late/started/unknown single and race imports fail before writes; every combine leg has a 30 minute lead', async () => {
  const { service, state } = memory();
  for (const item of [match({ startsAtUtc: '2026-10-23T08:29:59Z' }), match({ startsAtUtc: '2026-10-23T07:00:00Z' }), match({ status: 'started' }), match({ status: 'finished' }), match({ status: 'cancelled' }), match({ status: 'unknown' })]) await assert.rejects(service.importBatch(batch([item])));
  assert.equal(state.writes, 0);
  assert.equal(validateBatch(batch([match({ startsAtUtc: '2026-10-23T08:30:00Z' })]), clock()).items.length, 1);
  const race = horse(); race.startsAtUtc = '2026-10-23T08:20:00Z'; assert.throws(() => validateBatch(batch([race], 'rdj_turf_quinte'), clock()));
  const combined = combine(); combined.legs[1].startsAtUtc = '2026-10-23T08:29:59Z'; assert.throws(() => validateBatch(batch([combined], 'rdj_football_combine'), clock()));
  const misleadingParent = combine(); misleadingParent.startsAtUtc = '2026-10-23T20:00:00Z'; assert.throws(() => validateBatch(batch([misleadingParent], 'rdj_football_combine'), clock()));
  const unknownParent = combine(); unknownParent.startsAtUtc = null; assert.equal(validateBatch(batch([unknownParent], 'rdj_football_combine'), clock()).items[0].startsAtUtc, null);
});
test('Petit Journal explicit old slug cannot be relabeled with a new edition and kickoff', () => {
  for (const url of ['https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-le-petit-journal-du-parieur-du-22-octobre-2026.html', 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-journal-du-22-octobre.html', 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-journal-22-10-2026.html', 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-journal-du-22-octobre-2026-edition-23-10-2026.html']) {
    assert.throws(() => validateBatch(batch([match({ sourceUrl: url, startsAtUtc: '2026-10-23T19:00:00Z' })]), clock()));
  }
});
test('API and publisher editions use Europe/Paris across UTC midnight and DST; kickoff stays UTC', async () => {
  const { editionDateFor } = require('../src/api/services/common/editorialCalendar');
  assert.equal(editionDateFor('2026-10-24T22:30:00Z'), '2026-10-25');
  assert.equal(editionDateFor('2026-10-25T22:30:00Z'), '2026-10-25');
  assert.equal(editionDateFor('2026-10-25T23:30:00Z'), '2026-10-26');
  const instant = new Date('2026-10-23T22:00:00Z');
  const payload = { ...batch([match({ sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-journal-du-24-octobre-2026.html', startsAtUtc: '2026-10-23T22:40:00Z' })]), editionDate: '2026-10-24' };
  assert.equal(validateBatch(payload, instant).items[0].startsAtUtc, '2026-10-23T22:40:00.000Z');
  const { repository } = memory(); const service = createEditorialService({ repository, clock: () => instant });
  assert.equal((await service.workerConfig()).date, '2026-10-24'); assert.equal((await service.feed()).date, '2026-10-24');
  assert.throws(() => validateBatch(batch(), instant));
});

test('editorial HTTP errors keep the mobile code/message object contract and hide internal errors', async () => {
  const file = path.join(__dirname, '../src/api/controllers/common/editorialController.js');
  for (const [statusCode, suppliedCode, expectedCode] of [[400, null, 'VALIDATION_ERROR'], [401, null, 'AUTH_TOKEN_MISSING'], [403, 'SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_REQUIRED'], [403, 'RESOURCE_LOCKED', 'RESOURCE_LOCKED'], [404, null, 'NOT_FOUND'], [503, null, 'SERVICE_UNAVAILABLE'], [500, 'INTERNAL_SECRET', 'INTERNAL_ERROR']]) {
    const exports = {}, error = Object.assign(new Error('internal detail'), { statusCode, errorCode: suppliedCode });
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require: key => {
      assert.equal(key, '../../services/common/editorialService');
      return { getEditorialService: () => ({ feed: async () => { throw error; } }) };
    } });
    const res = response(); await exports.feed({ query: {}, headers: {} }, res);
    assert.equal(res.code, statusCode); assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, expectedCode); assert.equal(typeof res.body.error.message, 'string');
    assert.equal(res.body.error.message.includes('internal detail'), statusCode < 500);
  }
  const vip = memory([category({ isVip: true, editorialSource: 'rdj_football_analysis' })]);
  await vip.service.importBatch(batch([match({ sourceUrl: 'https://www.ruedesjoueurs.com/pronostic/equipe-a-equipe-b-12345.html' })], 'rdj_football_analysis'));
  await assert.rejects(vip.service.analysis(vip.state.rows[0]._id, { user }), { statusCode: 403, errorCode: 'SUBSCRIPTION_REQUIRED' });
  const free = memory([category({ accessGate: { type: 'ad_reward' } })]); await free.service.importBatch(batch());
  await assert.rejects(free.service.analysis(free.state.rows[0]._id, { user }), { statusCode: 403, errorCode: 'RESOURCE_LOCKED' });
});
