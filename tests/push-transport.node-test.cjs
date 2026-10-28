'use strict';

// Run real transport logic with in-memory provider/model doubles. No SDK,
// database connection, environment configuration or real recipient is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const API = path.resolve(__dirname, '..');
const apiRequire = createRequire(path.join(API, 'package.json'));
const payload = require('../src/api/services/push/payloadBuilder');
const TEXT = { id: 'editorial:wintips:fixture-edition', title: 'Fixture title', body: 'Fixture body' };
const silent = { info() {}, warn() {}, error() {} };

function modules(stubs) {
  const cache = new Map();
  function load(relative) {
    relative = relative.replaceAll('\\', '/');
    if (Object.hasOwn(stubs, relative)) return stubs[relative];
    if (cache.has(relative)) return cache.get(relative).exports;
    const file = path.join(API, relative), record = { exports: {} };
    cache.set(relative, record);
    const localRequire = name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (!name.startsWith('.')) return apiRequire(name);
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
      if (!path.posix.extname(target)) target += '.js';
      return load(target);
    };
    new Function('exports', 'require', 'module', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(
      record.exports, localRequire, record, file, path.dirname(file));
    return record.exports;
  }
  return load;
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    const value = record[key];
    if (condition === null) return value == null;
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('$ne' in condition) return value !== condition.$ne;
      if ('$lte' in condition) return value != null && value <= condition.$lte;
      if ('$lt' in condition) return value != null && value < condition.$lt;
    }
    return value === condition;
  });
}

function transport(rows, { response } = {}) {
  const calls = [], writes = [], filters = [], reclaimFilters = [], deliveries = new Map();
  const load = modules({
    'src/utils/logger.js': silent,
    'src/api/services/push/appContext.js': { appDoc: () => ({ appId: 'wintips' }), oneSignalDisponible: () => true },
    'src/api/models/common/Device.js': {
      find(query) {
        filters.push(query);
        return {
          select() { return this; }, lean() { return this; },
          async *cursor() {
            for (const row of rows) {
              if (row.isActive === false) continue;
              if (query.deviceId?.$in && !query.deviceId.$in.includes(row.deviceId)) continue;
              yield row;
            }
          },
        };
      },
      async bulkWrite(operations) { writes.push({ table: 'device', operations }); },
    },
    'src/api/models/common/PushDelivery.js': {
      async insertMany(docs) {
        writes.push({ table: 'claim', operations: docs });
        const writeErrors = [];
        docs.forEach((doc, index) => {
          if (deliveries.has(doc.msgId)) writeErrors.push({ index, code: 11000 });
          else deliveries.set(doc.msgId, { ...doc, status: 'queued', attempts: 1, retrySafe: false });
        });
        if (writeErrors.length) throw Object.assign(new Error('fixture duplicate'), { writeErrors });
      },
      async findOneAndUpdate(filter, update) {
        reclaimFilters.push(filter);
        const doc = deliveries.get(filter.msgId);
        if (!doc || !matches(doc, filter)) return null;
        Object.assign(doc, update.$set);
        for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + value;
        return { ...doc };
      },
      async bulkWrite(operations) {
        writes.push({ table: 'delivery-result', operations });
        for (const operation of operations) {
          const { filter, update } = operation.updateOne;
          const doc = deliveries.get(filter.msgId);
          if (doc && matches(doc, filter)) Object.assign(doc, update.$set);
        }
      },
    },
    'src/api/services/push/providerRouter.js': { resolve: row => ({ provider: row.provider === null ? null : row.provider || 'fcm' }) },
    'src/api/services/push/adapters/FcmAdapter.js': {
      async send(app, notification, targets, options) {
        calls.push({ provider: 'fcm', appId: app.appId, options, targets, messages: targets.map(target => payload.buildFcmMessage(notification, target)) });
        return targets.map(target => response ? response(target, options) : { deviceId: target.deviceId, ok: true, action: 'none' });
      },
    },
    'src/api/services/push/adapters/OneSignalAdapter.js': {
      async send(app, notification, targets) {
        calls.push({ provider: 'onesignal', targets });
        return targets.map(target => ({ deviceId: target.deviceId, ok: true, action: 'none' }));
      },
    },
  });
  return { service: load('src/api/services/push/pushService.js'), calls, writes, filters, reclaimFilters, deliveries };
}

test('historical FCM token aliases reserve and send only one physical endpoint', async () => {
  const fixture = transport([
    { deviceId: 'fixture-one', fcmToken: 'fixture-shared-token' },
    { deviceId: 'fixture-alias', fcmToken: 'fixture-shared-token' },
  ]);
  const result = await fixture.service.send('wintips', TEXT);
  assert.equal(result.fcm, 1); assert.equal(result.skipped, 1);
  assert.equal(fixture.deliveries.size, 1);
  assert.equal(fixture.calls.flatMap(call => call.messages).length, 1);
});

test('distinct endpoints retain their app or device language with identical event identity', async () => {
  const fixture = transport([
    { deviceId: 'fixture-fr', fcmToken: 'fixture-token-fr', language: 'fr' },
    { deviceId: 'fixture-en', fcmToken: 'fixture-token-en', deviceLanguage: 'en' },
  ]);
  const result = await fixture.service.send('wintips', {
    ...TEXT, title: { fr: 'Titre', en: 'Title' }, body: { fr: 'Texte', en: 'Body' },
  });
  assert.equal(result.fcm, 2);
  const messages = fixture.calls[0].messages;
  assert.deepEqual(messages.map(message => message.notification.title), ['Titre', 'Title']);
  assert.equal(messages[0].android.notification.tag, messages[1].android.notification.tag);
  assert.notEqual(messages[0].data.msgId, messages[1].data.msgId);
});

test('endpoint seen before a 1,000-device flush remains suppressed after that flush', async () => {
  const rows = Array.from({ length: 1_005 }, (_, i) => ({ deviceId: 'fixture-device-' + i, fcmToken: 'fixture-token-' + i }));
  rows.push({ deviceId: 'fixture-late-alias', fcmToken: 'fixture-token-0' });
  const fixture = transport(rows);
  const result = await fixture.service.send('wintips', TEXT);
  assert.equal(result.fcm, 1_005); assert.equal(result.skipped, 1);
  assert.deepEqual(fixture.calls.map(call => call.targets.length), [1_000, 5]);
  assert.equal(new Set(fixture.calls.flatMap(call => call.messages).map(message => message.token)).size, 1_005);
});

test('OneSignal aliases and endpoints shared across providers are delivered once per send', async () => {
  const fixture = transport([
    { deviceId: 'fixture-fcm', fcmToken: 'fixture-token', playerId: 'fixture-shared-player' },
    { deviceId: 'fixture-os-alias', playerId: 'fixture-shared-player', provider: 'onesignal' },
    { deviceId: 'fixture-os', playerId: 'fixture-player-two', provider: 'onesignal' },
    { deviceId: 'fixture-os-two-alias', playerId: 'fixture-player-two', provider: 'onesignal' },
  ]);
  const result = await fixture.service.send('wintips', TEXT);
  assert.equal(result.fcm, 1); assert.equal(result.onesignal, 1); assert.equal(result.skipped, 2);
  assert.equal(fixture.deliveries.size, 2);
});

test('explicit dry run neither claims deliveries nor mutates device/delivery results', async () => {
  const fixture = transport([
    { deviceId: 'fixture-fcm', fcmToken: 'fixture-token' },
    { deviceId: 'fixture-os', playerId: 'fixture-player', provider: 'onesignal' },
  ]);
  const simulated = await fixture.service.send('wintips', TEXT, { dryRun: true, retryFailures: true });
  assert.equal(simulated.dryRun, true); assert.equal(simulated.fcm, 1); assert.equal(simulated.onesignal, 1);
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.deliveries.size, 0);
  assert.equal(fixture.reclaimFilters.length, 0);
  assert.deepEqual(fixture.calls.map(call => call.provider), ['fcm']);
  assert.equal(fixture.calls[0].options.dryRun, true);
  const real = await fixture.service.send('wintips', TEXT);
  assert.equal(real.fcm, 1); assert.equal(real.onesignal, 1);
  assert.equal(fixture.deliveries.size, 2);
});

test('the global disabled flag also validates without consuming delivery claims', async () => {
  const previous = process.env.DISABLE_PUSH_NOTIFICATIONS;
  process.env.DISABLE_PUSH_NOTIFICATIONS = 'true';
  try {
    const fixture = transport([{ deviceId: 'fixture-device', fcmToken: 'fixture-token' }]);
    const result = await fixture.service.send('wintips', TEXT);
    assert.equal(result.dryRun, true); assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.calls[0].options.dryRun, true);
  } finally {
    if (previous === undefined) delete process.env.DISABLE_PUSH_NOTIFICATIONS;
    else process.env.DISABLE_PUSH_NOTIFICATIONS = previous;
  }
});

test('already accepted and acked deliveries are never reclaimed by retryFailures', async () => {
  const fixture = transport([{ deviceId: 'fixture-device', fcmToken: 'fixture-token' }]);
  assert.equal((await fixture.service.send('wintips', TEXT)).fcm, 1);
  const doc = [...fixture.deliveries.values()][0];
  assert.equal((await fixture.service.send('wintips', TEXT, { retryFailures: true })).fcm, 0);
  doc.status = 'acked'; doc.ackAt = new Date();
  assert.equal((await fixture.service.send('wintips', TEXT, { retryFailures: true })).fcm, 0);
  assert.equal(fixture.calls.length, 1);
});

test('provider completion cannot downgrade an ACK that arrived before result persistence', async () => {
  const fixture = transport([]), msgId = fixture.service.buildMsgId(TEXT.id, 'fixture-device');
  const ackAt = new Date();
  fixture.deliveries.set(msgId, {
    msgId, appId: 'wintips', notificationId: TEXT.id, deviceId: 'fixture-device',
    status: 'acked', ackAt, retrySafe: false, attempts: 1,
  });
  for (const result of [
    { ok: true, action: 'none' },
    { ok: false, action: 'retry', retrySafe: true, code: 'messaging/server-unavailable' },
  ]) {
    await fixture.service.applyResults('wintips', [{ ...result, deviceId: 'fixture-device', msgId }]);
    const doc = fixture.deliveries.get(msgId);
    assert.equal(doc.status, 'acked'); assert.equal(doc.ackAt, ackAt);
    assert.equal(doc.retrySafe, false); assert.equal(doc.attempts, 1);
  }
  const filters = fixture.writes.filter(write => write.table === 'delivery-result').flatMap(write => write.operations).map(operation => operation.updateOne.filter);
  assert.ok(filters.every(filter => filter.msgId === msgId && filter.status.$ne === 'acked'));
});

test('only an explicit failed safe unaccepted due delivery can be retried, keeping its tag', async () => {
  let reject = true;
  const fixture = transport([{ deviceId: 'fixture-device', fcmToken: 'fixture-token' }], {
    response: target => reject
      ? { deviceId: target.deviceId, ok: false, action: 'retry', code: 'messaging/server-unavailable', retrySafe: true }
      : { deviceId: target.deviceId, ok: true, action: 'none' },
  });
  assert.equal((await fixture.service.send('wintips', TEXT)).failed, 1);
  const doc = [...fixture.deliveries.values()][0];
  assert.equal(doc.retrySafe, true); assert.equal(doc.attempts, 1);
  doc.nextRetryAt = new Date(Date.now() - 1);
  assert.equal((await fixture.service.send('wintips', TEXT)).fcm, 0, 'retry is opt-in');
  reject = false;
  assert.equal((await fixture.service.send('wintips', TEXT, { retryFailures: true })).fcm, 1);
  assert.equal(doc.attempts, 2); assert.equal(doc.retrySafe, false); assert.equal(doc.status, 'sent');
  assert.equal(fixture.calls[0].messages[0].android.notification.tag, fixture.calls[1].messages[0].android.notification.tag);
  const guard = fixture.reclaimFilters.at(-1);
  assert.equal(guard.status, 'failed'); assert.equal(guard.retrySafe, true);
  assert.equal(guard.ackAt, null); assert.equal(guard.sentAt, null);
  assert.deepEqual(guard.attempts, { $lt: 5 });
});

test('ambiguous, acknowledged, not-due and exhausted failures remain unsent', async () => {
  for (const fields of [
    { status: 'queued', retrySafe: false },
    { status: 'failed', retrySafe: false },
    { status: 'failed', retrySafe: true, ackAt: new Date() },
    { status: 'failed', retrySafe: true, sentAt: new Date() },
    { status: 'failed', retrySafe: true, nextRetryAt: new Date(Date.now() + 60000) },
    { status: 'failed', retrySafe: true, attempts: 5 },
  ]) {
    const fixture = transport([{ deviceId: 'fixture-device', fcmToken: 'fixture-token' }]);
    const msgId = fixture.service.buildMsgId(TEXT.id, 'fixture-device');
    fixture.deliveries.set(msgId, {
      msgId, appId: 'wintips', notificationId: TEXT.id, deviceId: 'fixture-device',
      attempts: 1, nextRetryAt: new Date(Date.now() - 1), ...fields,
    });
    const result = await fixture.service.send('wintips', TEXT, { retryFailures: true });
    assert.equal(result.fcm, 0); assert.equal(result.skipped, 1); assert.equal(fixture.calls.length, 0);
  }
});

test('concurrent opt-in retry claims retain the existing atomic compare-and-set', async () => {
  const fixture = transport([]), msgId = fixture.service.buildMsgId(TEXT.id, 'fixture-device');
  fixture.deliveries.set(msgId, {
    msgId, appId: 'wintips', notificationId: TEXT.id, deviceId: 'fixture-device',
    status: 'failed', retrySafe: true, attempts: 1, nextRetryAt: new Date(Date.now() - 1),
  });
  const results = await Promise.all([1, 2].map(() => fixture.service.claimMany('wintips', TEXT.id,
    [{ deviceId: 'fixture-device', provider: 'fcm' }], { retryFailures: true })));
  assert.equal(results.reduce((sum, result) => sum + result.size, 0), 1);
  assert.equal(fixture.deliveries.get(msgId).attempts, 2);
});
