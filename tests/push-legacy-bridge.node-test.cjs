'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bridge = require('../src/api/services/push/legacyBridge');
const payload = require('../src/api/services/push/payloadBuilder');
const texts = require('../src/api/services/push/localizedText');

function load(relative, mocks, extras = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module, exports: module.exports, console,
    require(name) { assert.ok(Object.hasOwn(mocks, name), 'Unmocked dependency: ' + name); return mocks[name]; },
    ...extras,
  });
  return module.exports;
}

const legacy = {
  headings: { fr: 'Coupon du Jour', en: 'Daily Coupon' },
  contents: { fr: 'Edition du 28 octobre.', en: 'Edition for 28 October.' },
  data: { type: 'ticket', action: 'view_ticket', ticket_id: 'fixture-ticket' },
};

test('explicit legacy publication identity survives copy and language changes', () => {
  const first = bridge.toPushNotification({ ...legacy, data: { ...legacy.data, notificationId: 'ticket-published:fixture-1' } });
  const edited = bridge.toPushNotification({ ...legacy, headings: { fr: 'Titre modifie', en: 'Edited title' },
    data: { ...legacy.data, notificationId: 'ticket-published:fixture-1' } });
  assert.equal(first.id, 'ticket-published:fixture-1');
  assert.equal(first.id, edited.id);
  assert.equal(bridge.toPushNotification(legacy, 'explicit-argument').id, 'explicit-argument');
});

test('existing callers without an explicit identity keep their historical delivery IDs', () => {
  const historicalId = crypto.createHash('sha1').update(JSON.stringify({
    t: bridge.pickText(legacy.headings), c: bridge.pickText(legacy.contents), d: legacy.data,
  })).digest('base64url').slice(0, 22);
  assert.equal(bridge.toPushNotification(legacy).id, historicalId);
});

test('legacy bilingual publication renders FR/EN as strings under the same event and native tag', () => {
  const notification = bridge.toPushNotification({ ...legacy, data: { ...legacy.data, notificationId: 'ticket-published:fixture-1' } });
  const target = { fcmToken: 'fixture-token', msgId: 'fixture-delivery', language: 'fr' };
  const fr = payload.buildFcmMessage(notification, target);
  const en = payload.buildFcmMessage(notification, { ...target, language: 'en' });
  assert.deepEqual(fr.notification, { title: legacy.headings.fr, body: legacy.contents.fr });
  assert.deepEqual(en.notification, { title: legacy.headings.en, body: legacy.contents.en });
  assert.equal(fr.android.notification.tag, en.android.notification.tag);
  assert.equal(fr.data.notificationId, 'ticket-published:fixture-1');
});

test('dry-run transport validation never claims accepted recipients in the legacy response', () => {
  assert.equal(bridge.toLegacyResponse('fixture-event', { fcm: 3, onesignal: 2 }).recipients, 5);
  assert.equal(bridge.toLegacyResponse('fixture-event', { fcm: 3, onesignal: 2, dryRun: true }).recipients, 0);
});

test('OneSignal fallback receives valid bilingual text maps and original business navigation', async () => {
  let sent;
  const adapter = load('src/api/services/push/adapters/OneSignalAdapter.js', {
    axios: { post: async (url, data) => { sent = data; return { data: { id: 'fixture-provider-response' } }; } },
    '../../../../utils/logger': { error() {} }, '../localizedText': texts,
  });
  const notification = bridge.toPushNotification(legacy, 'fixture-event');
  const result = await adapter.send({ getOneSignalConfig: () => ({ appId: 'fixture-app', restApiKey: 'fixture-key' }) }, notification,
    [{ deviceId: 'fixture-device', playerId: 'fixture-player', msgId: 'fixture-msg' }]);
  assert.equal(result[0].ok, true);
  assert.equal(sent.headings.fr, legacy.headings.fr);
  assert.equal(sent.headings.en, legacy.headings.en);
  assert.equal(sent.contents.en, legacy.contents.en);
  assert.equal(sent.data.action, 'view_ticket');
  assert.equal(sent.data.notificationId, 'fixture-event');
});

test('global disable applies to the legacy OneSignal branch even after lazy initialization', async () => {
  let requests = 0;
  const fakeProcess = { env: { PUSH_ENGINE: 'onesignal', ONESIGNAL_APP_ID: 'fixture-app', ONESIGNAL_REST_API_KEY: 'fixture-key' } };
  const { AppError } = require('../src/utils/AppError');
  const service = load('src/api/services/common/notificationService.js', {
    axios: async () => { requests++; return { data: { id: 'fixture-provider-response' } }; },
    '../../../utils/logger': { info() {}, warn() {}, error() {} }, '../../../utils/AppError': { AppError },
    '../push/pushService': {}, '../push/legacyBridge': bridge,
    '../push/appContext': { appId: () => 'wintips' },
  }, { process: fakeProcess });
  await service.sendToAll(legacy);
  assert.equal(requests, 1);
  fakeProcess.env.DISABLE_PUSH_NOTIFICATIONS = 'true';
  await assert.rejects(service.sendToAll(legacy), /desactivees/);
  assert.equal(requests, 1);
});
