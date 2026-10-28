'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helper = require('../src/api/services/common/legacyTicketPublication');
const plain = value => JSON.parse(JSON.stringify(value));
const read = (object, path) => path.split('.').reduce((value, part) => value?.[part], object);
function write(object, path, value) {
  const parts = path.split('.');
  let node = object;
  for (const part of parts.slice(0, -1)) node = node[part] ||= {};
  node[parts.at(-1)] = plain(value);
}
function matches(row, filter) {
  return Object.entries(filter).every(([path, value]) => {
    const actual = read(row, path);
    if (value && typeof value === 'object') {
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$ne' in value) return actual !== value.$ne;
    }
    return actual === value;
  });
}
function harness(options = {}) {
  const row = { _id: 'ticket-28', category: 'category-1', date: '2026-10-28T07:00:00Z',
    isVisible: false, ...(options.row ? plain(options.row) : {}) };
  const category = Object.hasOwn(options, 'category') ? options.category : {
    _id: 'category-1', name: { fr: 'Sélection Expert', en: 'Expert Selection' }, isVip: true, isActive: true,
  };
  const calls = { provider: [], writes: [], reads: [], category: 0 };
  let schema, reservationFailures = options.reservationFailures || 0, categoryFailures = options.categoryFailures || 0;
  let receiptFailures = options.receiptFailures || 0;
  class Schema {
    static Types = { ObjectId: String };
    constructor(definition) { this.definition = definition; this.preHooks = {}; this.postHooks = {}; schema = this; }
    index() {}
    pre(name, hook) { this.preHooks[name] = hook; }
    post(name, hook) { this.postHooks[name] = hook; }
  }
  function apply(update) {
    for (const [key, value] of Object.entries(update)) if (!key.startsWith('$')) write(row, key, value);
    for (const [key, value] of Object.entries(update.$set || {})) write(row, key, value);
  }
  const model = {
    findOne(filter) {
      calls.reads.push(plain(filter));
      const snapshot = plain(row);
      return { select() { return this; }, lean: async () => matches(snapshot, filter) ? snapshot : null };
    },
    collection: { async updateOne(filter, update) {
      calls.writes.push({ filter: plain(filter), update: plain(update) });
      if (update.$set?.publicationNotification?.status === 'pending' && reservationFailures-- > 0) throw new Error('reservation unavailable');
      if (['sent', 'uncertain', 'not_needed'].includes(update.$set?.['publicationNotification.status']) && receiptFailures-- > 0) throw new Error('receipt unavailable');
      if (!matches(row, filter)) return { matchedCount: 0, modifiedCount: 0 };
      apply(update);
      return { matchedCount: 1, modifiedCount: 1 };
    } },
  };
  const mongoose = { Schema, model(name, definition) {
    if (name === 'Ticket' && definition) return model;
    if (name === 'Category') return { findById: async () => {
      calls.category++;
      if (categoryFailures-- > 0) throw new Error('category unavailable');
      return category;
    } };
    throw Error('Forbidden model ' + name);
  } };
  const service = { async sendToAll(notification) {
    assert.equal(row.publicationNotification.status, 'sending', 'provider must follow the persistent atomic claim');
    calls.provider.push(plain(notification));
    if (options.provider) return options.provider(notification);
    return { id: notification.data.notificationId, recipients: 10, _stats: { fcm: 10, onesignal: 0, failed: 0 } };
  } };
  const module = { exports: {} };
  const env = { ...(options.env || {}) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/models/common/Ticket.js'), 'utf8'), {
    module, exports: module.exports, process: { env }, console: { error() {} },
    require(name) {
      if (name === 'mongoose') return mongoose;
      if (name === '../../services/common/legacyTicketPublication') return helper;
      if (name === '../../services/common/notificationService') return service;
      throw Error('Unexpected dependency (no DB/provider allowed): ' + name);
    },
  }, { filename: 'Ticket.js' });
  const query = update => ({ model, update: plain(update), getUpdate() { return this.update; },
    setUpdate(value) { this.update = value; }, getQuery() { return { _id: row._id }; } });
  const pre = context => schema.preHooks.findOneAndUpdate.call(context);
  const post = (context, doc = plain(row)) => schema.postHooks.findOneAndUpdate.call(context, doc);
  async function run(update) {
    const context = query(update);
    await pre(context); apply(context.update); await post(context);
    return context;
  }
  return { row, calls, env, schema, query, pre, post, apply, run };
}

test('first legacy publication reserves before visibility and claims before a single provider send', async () => {
  const h = harness();
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.row.publicationNotification.status, 'sent');
  assert.equal(h.row.publicationNotification.notificationId, 'ticket-published:ticket-28');
  assert.equal(h.row.publicationNotification.counts.accepted, 10);
  assert.equal(h.calls.writes[0].update.$set.publicationNotification.status, 'pending');
  assert.equal(h.calls.provider[0].data.notificationId, 'ticket-published:ticket-28');
});

test('repeated visible writes and hide/republish cannot resend a published ticket', async () => {
  const h = harness();
  await h.run({ isVisible: true });
  await h.run({ $set: { isVisible: true } });
  await h.run({ isVisible: false });
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.row.publicationNotification.status, 'sent');
});

test('an already-visible historical ticket without a marker is skipped and remains skipped after hide/republish', async () => {
  for (const initialUpdate of [{ isVisible: true }, { isVisible: false }]) {
    const h = harness({ row: { isVisible: true } });
    await h.run(initialUpdate);
    await h.run({ isVisible: false });
    await h.run({ isVisible: true });
    assert.equal(h.calls.provider.length, 0);
    assert.equal(h.row.publicationNotification.status, 'not_needed');
    assert.equal(h.row.publicationNotification.reason, 'already_published_legacy');
  }
});

test('concurrent false-to-true publications claim a single dispatch', async () => {
  const h = harness();
  await Promise.all([h.run({ isVisible: true }), h.run({ $set: { isVisible: true } })]);
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.row.publicationNotification.status, 'sent');
});

test('a later request between visibility change and the first post hook cannot suppress the first publication', async () => {
  const h = harness();
  const first = h.query({ isVisible: true });
  await h.pre(first); h.apply(first.update);
  const firstDoc = plain(h.row);
  const second = h.query({ isVisible: true });
  await h.pre(second); h.apply(second.update);
  await h.post(second); await h.post(first, firstDoc);
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.row.publicationNotification.status, 'sent');
});

test('provider interruption becomes uncertain and later publication requests never replay it', async () => {
  const h = harness({ provider: async () => { throw Error('ambiguous provider timeout'); } });
  await h.run({ isVisible: true });
  assert.equal(h.row.publicationNotification.status, 'uncertain');
  await h.run({ isVisible: true });
  await h.run({ isVisible: false }); await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
});

test('loss of all receipt writes leaves sending permanently non-replayable', async () => {
  const h = harness({ receiptFailures: 2 });
  await h.run({ isVisible: true });
  assert.equal(h.row.publicationNotification.status, 'sending');
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
});

test('a provider-success receipt write failure becomes uncertain without a second provider call', async () => {
  const h = harness({ receiptFailures: 1 });
  await h.run({ isVisible: true });
  assert.equal(h.row.publicationNotification.status, 'uncertain');
  assert.equal(h.row.publicationNotification.reason, 'transport_interrupted');
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
});

test('a pre-provider category failure leaves pending and a later request can safely finish it', async () => {
  const h = harness({ categoryFailures: 1 });
  await h.run({ isVisible: true });
  assert.equal(h.row.publicationNotification.status, 'pending');
  assert.equal(h.calls.provider.length, 0);
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.row.publicationNotification.status, 'sent');
});

test('a reservation database failure aborts publication before any provider call', async () => {
  const h = harness({ reservationFailures: 1 });
  await assert.rejects(h.run({ isVisible: true }), /reservation unavailable/);
  assert.equal(h.row.isVisible, false);
  assert.equal(h.calls.provider.length, 0);
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
});

test('restart with pending can finish but restart with sending, uncertain or sent cannot resend', async () => {
  for (const status of ['pending', 'sending', 'uncertain', 'sent', 'not_needed']) {
    const h = harness({ row: { isVisible: true, publicationNotification: { notificationId: 'ticket-published:ticket-28', status } } });
    await h.run({ isVisible: true });
    assert.equal(h.calls.provider.length, status === 'pending' ? 1 : 0, status);
  }
});

test('missing, inactive, archived and editorial categories never use the legacy push producer', async () => {
  for (const category of [null, { isActive: false }, { catalogueArchived: true }, { editorialSource: 'rdj_petit_journal' }]) {
    const h = harness({ category });
    await h.run({ isVisible: true });
    assert.equal(h.calls.provider.length, 0);
    assert.equal(h.row.publicationNotification.status, 'not_needed');
  }
});

test('global disable suppresses the publication with no provider call or later replay', async () => {
  const h = harness({ env: { DISABLE_PUSH_NOTIFICATIONS: 'true' } });
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 0);
  assert.equal(h.row.publicationNotification.status, 'not_needed');
  assert.equal(h.row.publicationNotification.reason, 'notifications_disabled');
  h.env.DISABLE_PUSH_NOTIFICATIONS = 'false';
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 0);
});

test('a transport dry-run reports zero accepted and is not replayed as a real send later', async () => {
  const h = harness({ provider: async () => ({ id: 'simulation', _stats: { dryRun: true, fcm: 15, onesignal: 0, failed: 0 } }) });
  await h.run({ isVisible: true });
  assert.equal(h.row.publicationNotification.status, 'not_needed');
  assert.equal(h.row.publicationNotification.counts.accepted, 0);
  await h.run({ isVisible: true });
  assert.equal(h.calls.provider.length, 1);
});

test('partial and unconfirmed transport results remain uncertain instead of claiming complete success', async () => {
  for (const response of [{ id: 'partial', _stats: { fcm: 2, failed: 1 } }, {}]) {
    const h = harness({ provider: async () => response });
    await h.run({ isVisible: true });
    assert.equal(h.row.publicationNotification.status, 'uncertain');
    await h.run({ isVisible: true });
    assert.equal(h.calls.provider.length, 1);
  }
});

test('an echoed admin ticket cannot reset its permanent publication marker', async () => {
  const h = harness();
  await h.run({ isVisible: true });
  await h.run({ isVisible: true, publicationNotification: { notificationId: 'ticket-published:ticket-28', status: 'pending' } });
  await h.run({ $set: { isVisible: true, 'publicationNotification.status': 'pending' }, $unset: { publicationNotification: '' } });
  const rename = await h.run({ $set: { isVisible: true }, $rename: {
    publicationNotification: 'oldNotification', scratch: 'publicationNotification.status',
  } });
  assert.deepEqual(plain(rename.update.$rename), {});
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.row.publicationNotification.status, 'sent');
});

test('non-visibility updates and raw updateOne bridge publication never run a push hook', async () => {
  const h = harness();
  await h.run({ closingAt: '2026-10-28T21:00:00Z' });
  assert.equal(h.calls.provider.length, 0);
  assert.equal(h.calls.reads.length, 0);
  assert.equal(Object.hasOwn(h.schema.postHooks, 'updateOne'), false);
});

test('legacy publication copy is deterministic, dated in UTC and truthful in both languages', () => {
  const category = { _id: 'cat-1', name: { fr: 'Sélection Expert', en: 'Expert Selection' }, isVip: true,
    description: { en: 'A daily live prediction' } };
  const ticket = { _id: 'ticket-1', date: '2026-10-28T00:30:00+02:00' };
  const notification = helper.buildLegacyTicketPublication(ticket, category);
  assert.deepEqual(notification, helper.buildLegacyTicketPublication(ticket, category));
  assert.equal(notification.headings.fr, '💎 Sélection Expert · VIP');
  assert.equal(notification.headings.en, '💎 Expert Selection · VIP');
  assert.equal(notification.data.notificationId, 'ticket-published:ticket-1');
  assert.equal(notification.data.type, 'ticket');
  assert.equal(notification.data.edition_date, '2026-10-27');
  assert.match(notification.contents.fr, /27 octobre 2026/);
  assert.match(notification.contents.en, /27 October 2026/);
  assert.doesNotMatch(JSON.stringify(notification), /99%|2\.00|garanti|guarantee/i);
});

test('legacy names and actual LIVE identity remain compatible without inventing a date', () => {
  const notification = helper.buildLegacyTicketPublication({ _id: 'ticket-live', date: 'invalid' }, { _id: 'live', name: 'LIVE', isVip: true });
  assert.equal(notification.data.action, 'view_live');
  assert.equal(notification.data.type, 'live');
  assert.equal(notification.data.vip, true);
  assert.equal(notification.headings.en, '🔴 LIVE · VIP');
  assert.equal(Object.hasOwn(notification.data, 'edition_date'), false);
  const free = helper.buildLegacyTicketPublication({ _id: 'free' }, { name: 'Découverte', isVip: false });
  assert.match(free.headings.fr, /Gratuit/);
  assert.match(free.headings.en, /Free/);
  assert.equal(free.data.action, 'view_ticket');
});
