'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFcmMessage, TTL_MS } = require('../src/api/services/push/payloadBuilder');

const publication = {
  id: 'editorial:wintips:fixture-edition:fixture-category',
  title: 'Le journal est disponible', body: 'Le programme du jour.',
  businessChannel: 'vip', requiresVip: true, route: '/edition/fixture',
  extra: { type: 'editorial', action: 'view_editorial_feed', editionDate: '2026-10-28' },
};
const target = { deviceId: 'fixture-device', fcmToken: 'fixture-token', msgId: 'fixture-msg-fr', language: 'fr' };

test('native tag survives retries, translated text and endpoint changes', () => {
  const fr = buildFcmMessage(publication, target);
  const en = buildFcmMessage({ ...publication, title: 'The journal is available', body: 'Today schedule.' }, {
    ...target, deviceId: 'fixture-alias', fcmToken: 'fixture-rotated-token', msgId: 'fixture-msg-en', language: 'en',
  });
  assert.equal(fr.android.notification.tag, en.android.notification.tag);
  assert.match(fr.android.notification.tag, /^wt-event-[a-f0-9]{40}$/);
  assert.equal(en.notification.title, 'The journal is available');
  assert.equal(en.data.msgId, 'fixture-msg-en');
});

test('different editions and result/publication events keep separate native notifications', () => {
  const tags = [publication.id, 'editorial:wintips:next-edition:fixture-category', 'editorial-result:wintips:fixture-edition:fixture-category']
    .map(id => buildFcmMessage({ ...publication, id }, target).android.notification.tag);
  assert.equal(new Set(tags).size, 3);
});

test('missing event identity omits the native tag instead of replacing unrelated messages', () => {
  for (const id of [undefined, null, '', '   ']) {
    assert.equal(Object.hasOwn(buildFcmMessage({ ...publication, id }, target).android.notification, 'tag'), false);
  }
});

test('business extras cannot change delivery or event identity', () => {
  const message = buildFcmMessage({ ...publication, extra: {
    ...publication.extra, msgId: 'untrusted-msg', notificationId: 'untrusted-event',
  } }, target);
  assert.equal(message.data.msgId, target.msgId);
  assert.equal(message.data.notificationId, publication.id);
  assert.equal(message.android.notification.tag, buildFcmMessage(publication, target).android.notification.tag);
});

test('native replacement preserves hybrid payload, business routes and OEM delivery settings', () => {
  const message = buildFcmMessage(publication, target);
  assert.deepEqual(message.notification, { title: publication.title, body: publication.body });
  assert.equal(message.data.route, publication.route);
  assert.equal(message.data.type, 'editorial');
  assert.equal(message.data.action, 'view_editorial_feed');
  assert.equal(message.data.ack, '1');
  assert.equal(message.data.vip, 'true');
  assert.equal(message.token, target.fcmToken);
  assert.equal(message.android.ttl, TTL_MS.vip);
  assert.equal(message.android.priority, 'high');
  assert.equal(message.android.collapseKey, 'vip');
  assert.equal(message.android.notification.channelId, 'vip_v1');
});

test('localized legacy text maps choose target app language, then device language', () => {
  const notification = { ...publication,
    title: { fr: 'Titre francais', en: 'English title' },
    body: { fr: 'Texte francais', en: 'English text' },
  };
  const fr = buildFcmMessage(notification, target);
  const en = buildFcmMessage(notification, { ...target, language: 'en', deviceLanguage: 'fr' });
  const deviceEn = buildFcmMessage(notification, { ...target, language: undefined, deviceLanguage: 'en' });
  const legacyDeviceEn = buildFcmMessage(notification, { ...target, language: 'legacy-invalid', deviceLanguage: 'en-GB' });
  assert.equal(fr.notification.title, 'Titre francais');
  assert.equal(en.notification.title, 'English title');
  assert.equal(deviceEn.notification.title, 'English title');
  assert.equal(legacyDeviceEn.notification.title, 'English title');
  assert.equal(en.notification.body, 'English text');
  assert.equal(fr.android.notification.tag, en.android.notification.tag);
});
