const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { preferences, preferredLanguage } = require('../src/api/services/common/devicePreferences');
const { createEditorialNotificationService, notificationId, message } = require('../src/api/services/common/editorialNotifications');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { validateBatch, hasCompleteEnglish } = require('../src/api/services/common/editorialValidation');

const date = '2026-10-23', clock = () => new Date(date + 'T08:00:00Z');
const catId = 'a'.repeat(24);
function item() { return { sourceId: '12345', sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-journal-du-23-octobre.html',
  kind: 'match', title: { fr: 'Brest — Nice', en: 'Brest — Nice' }, summary: { fr: 'Deux equipes.', en: 'Two teams.' }, startsAtUtc: date + 'T19:00:00Z',
  sport: { key: 'football', name: 'Football' }, competition: { name: 'Coupe' }, teams: { home: { name: 'Brest' }, away: { name: 'Nice' } },
  analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Brest a gagne 3 de ses 5 matchs.'] }], en: [{ heading: 'Context', paragraphs: ['Brest won 3 of their 5 matches.'] }] },
  selection: { label: { fr: 'Brest ou nul', en: 'Brest or draw' }, odds: 1.5 }, status: 'upcoming' }; }
const batch = (value = item()) => ({ source: 'rdj_petit_journal', editionDate: date, items: [value] });
function group(vip = false) { return { category: { _id: catId, isVip: vip }, source: vip ? 'rdj_football_analysis' : 'rdj_petit_journal', editionDate: date,
  items: [{ _id: 'b'.repeat(24), payload: item() }] }; }
const device = (n, extras = {}) => ({ _id: String(n).padStart(24, '0'), deviceId: 'device-' + n, editorialSchemaVersion: 1, ...extras });
function harness({ devices = [device(1, { language: 'fr' }), device(2, { language: 'en' })], vip = false, enabled = true, appId = 'wintips', globalOff = false, maxBatches = 100, summary } = {}) {
  const state = { devices, ledger: null, claims: 0, checkpoints: 0, finishes: 0, calls: [], delivered: new Set(), groups: [group(vip)], allowed: ['entitled'] };
  const repository = {
    groups: async () => state.groups, assertIndexes: async () => {}, categoryStillMatches: async () => true,
    entitledUsers: async () => state.allowed,
    deviceBatch: async (after, limit) => state.devices.filter(d => !after || d._id > after).slice(0, limit),
    claim: async () => {
      if (state.ledger && !['pending', 'retry_pending'].includes(state.ledger.status)) return null;
      state.claims++; state.ledger = { ...state.ledger, status: 'processing', lockToken: 'lock', passes: (state.ledger?.passes || 0) + 1 }; return { ...state.ledger };
    },
    ledgerState: async () => state.ledger && { status: state.ledger.status, stats: state.ledger.stats },
    checkpoint: async (key, token, after) => { state.checkpoints++; state.ledger.afterDeviceId = after; },
    finish: async (key, token, fields) => { state.finishes++; Object.assign(state.ledger, fields); },
    deliverySummary: async () => summary || ({ accepted: state.delivered.size, failed: 0, uncertain: 0, retryable: 0 }),
  };
  const push = async (app, notification, options) => {
    state.calls.push({ app, notification, options }); let fcm = 0;
    for (const deviceId of options.targeting.deviceIds) if (!state.delivered.has(deviceId)) { state.delivered.add(deviceId); fcm++; }
    return { fcm, onesignal: 0 };
  };
  return { state, repository, push, service: createEditorialNotificationService({ repository, push, clock, appId: () => appId, enabled: () => enabled,
    importEnabled: () => true, globallyDisabled: () => globalOff, maxBatches }) };
}
function load(relative, mocks, extras = {}) {
  const module = { exports: {} }, file = path.join(__dirname, '..', relative);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, process, console, ...extras,
    require: key => { if (!(key in mocks)) throw new Error('Unexpected dependency: ' + key); return mocks[key]; } }, { filename: file });
  return module.exports;
}

test('registration preferences normalize app first, validate consent and retain omitted fields', () => {
  assert.deepEqual(preferences({}), {});
  assert.deepEqual(preferences({ appLanguage: 'en-GB', language: 'fr', deviceLanguage: 'fr_FR', notificationsEnabled: false }), { language: 'en', deviceLanguage: 'fr', notificationsEnabled: false });
  for (const input of [{ language: '<script>' }, { notificationsEnabled: 'false' }, { appLanguage: [] }]) assert.throws(() => preferences(input));
  assert.equal(preferences({ editorialSchemaVersion: 1 }).editorialSchemaVersion, 1);
  for (const version of [0, 2, '1', null]) assert.throws(() => preferences({ editorialSchemaVersion: version }));
  assert.equal(preferredLanguage({ language: 'en', deviceLanguage: 'fr' }), 'en');
  assert.equal(preferredLanguage({ deviceLanguage: 'en' }), 'en');
  assert.equal(preferredLanguage({ language: 'legacy unsupported' }), 'fr');
});
test('locale-only register preserves user, token and existing preference on omission; invalid data writes nothing', async () => {
  let lookups = 0, saves = 0;
  const saved = { user: 'existing-user', language: 'en', editorialSchemaVersion: 1, notificationsEnabled: false, fcmToken: 'same', deviceInfo: {}, save: async function () { saves++; return this; } };
  const service = load('src/api/services/common/deviceService.js', {
    '../../models/common/Device': { findOne: async () => { lookups++; return saved; } },
    '../../../utils/AppError': require('../src/utils/AppError'), './devicePreferences': { preferences },
  });
  await service.registerDevice({ deviceId: 'one', platform: 'android' });
  assert.equal(saved.user, 'existing-user'); assert.equal(saved.fcmToken, 'same'); assert.equal(saved.language, 'en'); assert.equal(saved.notificationsEnabled, false);
  assert.equal(saved.editorialSchemaVersion, 1);
  await service.registerDevice({ deviceId: 'one', platform: 'android', appLanguage: 'fr', notificationsEnabled: true });
  assert.equal(saved.language, 'fr'); assert.equal(saved.notificationsEnabled, true); assert.equal(saved.user, 'existing-user');
  await service.registerDevice({ deviceId: 'one', platform: 'android', fcmToken: 'same' });
  assert.equal(saved.fcmTokenSource, 'sdk'); assert.ok(saved.fcmTokenUpdatedAt.getTime() > 0);
  await assert.rejects(service.registerDevice({ language: 'invalid' })); assert.equal(lookups, 3); assert.equal(saves, 3);
});
test('disabled flags, global stop and other app prevent both sends and ledger writes', async () => {
  for (const options of [{ enabled: false }, { globalOff: true }, { appId: 'predictfoot' }]) {
    const { service, state } = harness(options); const result = await service.drain({ dryRun: false });
    assert.equal(result.disabled, true); assert.equal(state.claims, 0); assert.equal(state.calls.length, 0);
  }
});
test('secure dry-run groups languages without provider calls or delivery-state mutations', async () => {
  const { service, state } = harness(); const result = await service.drain();
  assert.deepEqual(result.groups[0].languages, { fr: 1, en: 1 }); assert.equal(state.claims, 0); assert.equal(state.finishes, 0); assert.equal(state.calls.length, 0);
  await assert.rejects(service.drain({ dryRun: 'false' })); await assert.rejects(service.drain({ editionDate: '2026-10-22' }));
});
test('FR/EN grouping uses stable identity, no pick leak and correct deep-link keys', async () => {
  const { service, state } = harness({ devices: [device(1, { language: 'fr' }), device(2, { language: 'en' }), device(3, { deviceLanguage: 'en' }), device(4), device(5, { notificationsEnabled: false })] });
  const result = await service.drain({ dryRun: false }); assert.equal(result.sent, 4); assert.equal(result.groups[0].status, 'completed');
  assert.equal(state.calls.length, 2); const [fr, en] = state.calls;
  assert.equal(fr.notification.id, en.notification.id); assert.match(fr.notification.title, /23 octobre/); assert.match(en.notification.title, /23 October/);
  assert.equal(fr.notification.extra.action, 'view_editorial'); assert.equal(en.notification.extra.itemId, 'b'.repeat(24)); assert.equal(en.notification.extra.categoryId, catId);
  assert.equal(en.notification.extra.isVip, 'false'); assert.equal(en.notification.extra.editionDate, date);
  assert.equal(JSON.stringify(en.notification).includes('Brest or draw'), false); assert.equal(JSON.stringify(en.notification).includes('1.5'), false);
  assert.equal(en.options.retryFailures, true); assert.equal(en.options.respectNotificationPreferences, true);
  const again = await service.drain({ dryRun: false }); assert.equal(again.sent, 0); assert.equal(state.calls.length, 2);
});
test('VIP recipient rights come from current category entitlement, not device userType', async () => {
  const { service, state } = harness({ vip: true, devices: [device(1, { user: 'entitled', language: 'en' }), device(2, { user: 'expired', userType: 'vip' }), device(3, { userType: 'vip' }), device(4, { user: 'wrong-category' })] });
  const result = await service.drain({ dryRun: false }); assert.equal(result.sent, 1);
  assert.deepEqual(state.calls[0].options.targeting.deviceIds, ['device-1']); assert.equal(state.calls[0].notification.requiresVip, true);
});
test('concurrent drains cannot claim the same edition twice', async () => {
  const { service, state } = harness(); await Promise.all([service.drain({ dryRun: false }), service.drain({ dryRun: false })]);
  assert.equal(state.claims, 1); assert.equal(state.delivered.size, 2); assert.equal(state.calls.length, 2);
});
test('bounded drain resumes its saved cursor and finalizes only after reaching the end', async () => {
  const { service, state } = harness({ maxBatches: 1 });
  const first = await service.drain({ dryRun: false }); assert.equal(first.groups[0].status, 'pending'); assert.equal(state.ledger.afterDeviceId, device(2)._id);
  const next = await service.drain({ dryRun: false }); assert.equal(next.groups[0].status, 'completed'); assert.equal(state.calls.length, 2);
});
test('known failed recipients are retry-pending, ambiguous queued recipients require review', async () => {
  let pair = harness({ summary: { accepted: 1, retryable: 1, failed: 0, uncertain: 0 } });
  let result = await pair.service.drain({ dryRun: false }); assert.equal(result.groups[0].status, 'retry_pending'); assert.equal(pair.state.ledger.afterDeviceId, null);
  pair = harness({ summary: { accepted: 1, retryable: 0, failed: 0, uncertain: 1 } });
  result = await pair.service.drain({ dryRun: false }); assert.equal(result.groups[0].status, 'review_required');
  const sends = pair.state.calls.length, finishes = pair.state.finishes;
  const again = await pair.service.drain({ dryRun: false });
  assert.equal(again.groups[0].status, 'review_required'); assert.equal(again.groups[0].stats.uncertain, 1);
  assert.equal(again.sent, 0); assert.equal(pair.state.claims, 1);
  assert.equal(pair.state.calls.length, sends); assert.equal(pair.state.finishes, finishes);
});

test('terminal ledger monitoring reads only status and summary by exact durable identity', async () => {
  const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
  const key = { appId: 'wintips', categoryId: catId, source: 'rdj_petit_journal', editionDate: date };
  let filter, projection;
  const state = { status: 'review_required', stats: { uncertain: 1 } };
  const repo = createEditorialNotificationRepository({ EditorialNotification: { findOne: input => {
    filter = input; return { select: fields => { projection = fields; return { lean: async () => state }; } };
  } } });
  assert.equal(await repo.ledgerState(key), state); assert.deepEqual(filter, key);
  assert.equal(projection, 'status stats -_id');
});
test('late content is not announced; missing or imperfect translation cannot suppress notifications', async () => {
  const { service, state } = harness(); state.groups[0].items[0].payload.startsAtUtc = date + 'T08:20:00Z';
  assert.equal((await service.drain({ dryRun: false })).groups.length, 0); assert.equal(state.claims, 0);
  state.groups[0] = group(); delete state.groups[0].items[0].payload.analysis.en;
  const sent = await service.drain({ dryRun: false });
  assert.equal(sent.groups.length, 1); assert.equal(state.claims, 1);
  assert.deepEqual(state.calls.map(call => call.notification.extra.language), ['fr', 'en']);
  const poor = harness(); poor.state.groups[0].items[0].payload.analysis.en[0].paragraphs[0] = 'Lyon won 999 matches.';
  assert.equal((await poor.service.drain({ dryRun: false })).groups.length, 1);
  assert.equal(poor.state.calls.length, 2);
  const multiple = group(); multiple.items.push({ _id: 'c'.repeat(24), payload: item() });
  const m = message('wintips', multiple, 'en'); assert.equal(m.extra.action, 'view_editorial_feed'); assert.equal(m.extra.itemId, undefined);
  assert.equal(notificationId('wintips', group()), notificationId('wintips', group())); assert.notEqual(notificationId('predictfoot', group()), notificationId('wintips', group()));
});
test('default import keeps imperfect English and completes missing text with the French source', async () => {
  let writes = 0, saved;
  const repository = { categories: async () => [{ _id: catId, isActive: true, isVip: false, editorialSource: 'rdj_petit_journal' }], upsertBatch: async operations => { writes++; saved = operations[0].updateOne.update.$set.payload; return {}; } };
  const service = createEditorialService({ repository, clock, importEnabled: () => true });
  const original = item(); delete original.analysis.en;
  await service.importBatch(batch(original)); assert.equal(writes, 1);
  assert.deepEqual(saved.analysis.en, original.analysis.fr);
  assert.equal(original.analysis.en, undefined, 'caller payload is not mutated');
  const partial = item(); partial.analysis.en[0].paragraphs.push('Extra invented context.');
  await service.importBatch(batch(partial)); assert.equal(writes, 2);
  assert.deepEqual(saved.analysis.en, partial.analysis.en, 'supplied translation is retained');
  const altered = item(); altered.analysis.en[0].paragraphs[0] = 'Brest won 4 of their 5 matches.';
  await service.importBatch(batch(altered)); assert.equal(writes, 3);
  assert.equal(saved.analysis.en[0].paragraphs[0], altered.analysis.en[0].paragraphs[0]);
  assert.equal(saved.selection.odds, original.selection.odds);
  assert.equal(saved.startsAtUtc, new Date(original.startsAtUtc).toISOString());
  assert.equal(hasCompleteEnglish({ ...item(), legs: [original] }), false);
  const novel = item(); novel.selection.label = { fr: 'Dou\u00e9 d\u00e9cisif', en: 'Dou\u00e9 decisive' }; novel.selection.betType = 'player_contribution';
  await service.importBatch(batch(novel)); assert.equal(writes, 4);
  assert.equal(saved.selection.label.fr, novel.selection.label.fr);
  assert.equal(saved.selection.label.en, novel.selection.label.en);
  await service.importBatch(batch()); assert.equal(writes, 5); assert.equal((await service.workerConfig()).requireEnglish, true);
});
test('invalid English candidates fall back before schema checks without weakening French or source facts', async () => {
  let saved, writes = 0;
  const repository = { categories: async () => [{ _id: catId, isActive: true, isVip: false, editorialSource: 'rdj_petit_journal' }],
    upsertBatch: async operations => { writes++; saved = operations[0].updateOne.update.$set.payload; return {}; } };
  const service = createEditorialService({ repository, clock, importEnabled: () => true });
  const mutations = [
    row => { row.title.en = 'X'.repeat(501); },
    row => { row.summary.en = { html: '<script>untrusted()</script>' }; },
    row => { row.selection.label.en = null; },
    row => { row.selection.label.en = 'text\u0000'; },
    row => { row.analysis.en = 'not structured prose'; },
    row => { row.analysis.en = []; },
    row => { row.analysis.en[0].heading = ''; },
    row => { row.analysis.en[0].paragraphs = []; },
    row => { row.analysis.en[0].paragraphs[0] = 'X'.repeat(6001); },
    row => { row.analysis.en[0].paragraphs[0] = { unexpected: true }; },
    row => { row.analysis.en[0].unknown = 'untrusted field'; },
  ];
  for (const mutate of mutations) {
    const row = item(); mutate(row);
    assert.equal((await service.importBatch(batch(row))).imported, 1);
    assert.equal(hasCompleteEnglish(saved), true);
    assert.deepEqual(saved.analysis.fr, row.analysis.fr);
    assert.equal(saved.selection.odds, 1.5);
    assert.deepEqual(saved.teams, row.teams);
    assert.equal(saved.startsAtUtc, new Date(row.startsAtUtc).toISOString());
  }
  const completed = writes;
  for (const mutate of [row => { row.title.fr = ''; }, row => { row.analysis.fr[0].paragraphs = []; },
    row => { row.selection.odds = -1; }, row => { row.sourceUrl = 'https://attacker.invalid/article'; }]) {
    const row = item(); mutate(row); await assert.rejects(service.importBatch(batch(row)));
  }
  assert.equal(writes, completed);
});
test('import sends only after successful persistence; notification failure does not undo published data', async () => {
  const order = [], repository = { categories: async () => [{ _id: catId, isActive: true, isVip: false, editorialSource: 'rdj_petit_journal' }], upsertBatch: async () => { order.push('persist'); return {}; } };
  const notifications = { enabled: () => true, drain: async () => { order.push('notify'); throw new Error('provider unavailable'); } };
  const service = createEditorialService({ repository, clock, importEnabled: () => true, notifications });
  const result = await service.importBatch(batch()); assert.deepEqual(order, ['persist', 'notify']); assert.equal(result.imported, 1); assert.equal(result.notifications.pending, true);
  repository.upsertBatch = async () => { throw new Error('database failure'); }; order.length = 0;
  await assert.rejects(service.importBatch(batch())); assert.deepEqual(order, []);
  await assert.rejects(service.drainNotifications({ categoryId: catId, dryRun: false }));
});
test('FCM retries only explicit per-recipient negatives, never an ambiguous transport failure', async () => {
  let transport = false;
  const adapter = load('src/api/services/push/adapters/FcmAdapter.js', {
    '../firebaseApps': { getMessagingFor: () => ({ sendEach: async () => {
      if (transport) throw Object.assign(new Error('ambiguous'), { code: 'messaging/server-unavailable' });
      return { responses: [{ success: false, error: { code: 'messaging/server-unavailable' } }] };
    } }) }, '../payloadBuilder': { buildFcmMessage: () => ({}) },
  });
  let result = await adapter.send({}, {}, [{ deviceId: 'one' }]); assert.equal(result[0].retrySafe, true);
  transport = true; result = await adapter.send({}, {}, [{ deviceId: 'one' }]); assert.notEqual(result[0].retrySafe, true);
});
test('OneSignal retries a confirmed 429, never ambiguous server/network outcomes', async () => {
  let status = 429;
  const adapter = load('src/api/services/push/adapters/OneSignalAdapter.js', {
    axios: { post: async () => { throw { response: { status } }; } }, '../../../../utils/logger': { error() {} },
    '../localizedText': require('../src/api/services/push/localizedText'),
  });
  const app = { getOneSignalConfig: () => ({ appId: 'fixture', restApiKey: 'fixture' }) };
  let result = await adapter.send(app, { id: 'message' }, [{ deviceId: 'one' }]); assert.equal(result[0].retrySafe, true);
  status = 500; result = await adapter.send(app, { id: 'message' }, [{ deviceId: 'one' }]); assert.equal(result[0].retrySafe, false);
});
test('shared push reclaim is opt-in and uses atomic failed/safe/unacked/unaccepted guards', async () => {
  const filters = []; let reclaimed = false;
  const delivery = { insertMany: async () => { throw { writeErrors: [{ index: 0, code: 11000 }] }; },
    findOneAndUpdate: async filter => { filters.push(filter); if (reclaimed) return null; reclaimed = true; return {}; } };
  const service = load('src/api/services/push/pushService.js', {
    crypto: require('crypto'), '../../../utils/logger': {}, './appContext': {}, '../../models/common/Device': {},
    '../../models/common/PushDelivery': delivery, './providerRouter': {}, './adapters/FcmAdapter': {}, './adapters/OneSignalAdapter': {},
  });
  assert.equal((await service.claimMany('wintips', 'id', [{ deviceId: 'one', provider: 'fcm' }])).size, 0); assert.equal(filters.length, 0);
  const results = await Promise.all([service.claimMany('wintips', 'id', [{ deviceId: 'one', provider: 'fcm' }], { retryFailures: true }), service.claimMany('wintips', 'id', [{ deviceId: 'one', provider: 'fcm' }], { retryFailures: true })]);
  assert.equal(results.reduce((n, result) => n + result.size, 0), 1);
  assert.equal(filters[0].status, 'failed'); assert.equal(filters[0].retrySafe, true); assert.equal(filters[0].ackAt, null); assert.equal(filters[0].sentAt, null); assert.equal(filters[0].appId, 'wintips');
  assert.equal(filters[0].attempts.$lt, 5); assert.ok(Number.isFinite(filters[0].nextRetryAt.$lte.getTime()));
  assert.equal(service.audienceFilter({ deviceIds: ['one'], respectNotificationPreferences: true }).notificationsEnabled.$ne, false);
  assert.equal(service.audienceFilter({ deviceIds: ['one'], respectEditorialSchemaVersion: true }).editorialSchemaVersion, 1);
});

test('notification DAL requires both durable identity and gateway delivery unique indexes without DDL', async () => {
  const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
  let keys = [], delivery = [], writes = 0;
  const repo = createEditorialNotificationRepository({ EditorialNotification: { collection: { listIndexes: () => ({ toArray: async () => keys }), createIndex: async () => { writes++; } } },
    PushDelivery: { collection: { listIndexes: () => ({ toArray: async () => delivery }) } } });
  await assert.rejects(repo.assertIndexes(), { statusCode: 503 });
  keys = [{ name: 'editorial_notification_identity_unique', unique: true, key: { appId: 1, categoryId: 1, source: 1, editionDate: 1 } }];
  await assert.rejects(repo.assertIndexes(), { statusCode: 503 });
  delivery = [{ name: 'msgId_1', unique: true, key: { msgId: 1 } }]; await repo.assertIndexes(); assert.equal(writes, 0);
});
test('VIP audience DAL uses active users, active unexpired subscriptions and current package category membership', async () => {
  const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
  let userFilter, subscriptionFilter;
  const repo = createEditorialNotificationRepository({
    User: { find: filter => { userFilter = filter; return { select: () => ({ lean: async () => [{ _id: 'allowed-user' }] }) }; } },
    Subscription: { find: filter => { subscriptionFilter = filter; return { select: () => ({ populate: () => ({ lean: async () => [
      { user: 'allowed-user', package: { isActive: false, categories: [catId] } },
      { user: 'wrong-user', package: { categories: ['different-category'] } }, { user: 'deleted-package', package: null },
    ] }) }) }; } },
  });
  assert.deepEqual(await repo.entitledUsers(catId, ['allowed-user', 'disabled-user'], clock()), ['allowed-user']);
  assert.equal(userFilter.isActive, true); assert.deepEqual(subscriptionFilter.user.$in, ['allowed-user']);
  assert.equal(subscriptionFilter.status, 'active'); assert.equal(subscriptionFilter.endDate.$gt.toISOString(), clock().toISOString());
});

test('old devices without editorial capability never receive the new deep links', async () => {
  const pair = harness({ devices: [device(1), device(2, { editorialSchemaVersion: undefined }), device(3, { editorialSchemaVersion: 2 })] });
  const result = await pair.service.drain({ dryRun: false }); assert.equal(result.sent, 1);
  assert.deepEqual(pair.state.calls[0].options.targeting.deviceIds, ['device-1']);
  assert.equal(pair.state.calls[0].options.respectEditorialSchemaVersion, true);
  const { createEditorialNotificationRepository } = require('../src/api/services/common/editorialNotificationRepository');
  let filter;
  const chain = { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [] };
  const repo = createEditorialNotificationRepository({ Device: { find: input => { filter = input; return chain; } } });
  await repo.deviceBatch(null, 250); assert.equal(filter.editorialSchemaVersion, 1); assert.equal(filter.notificationsEnabled.$ne, false);
});
