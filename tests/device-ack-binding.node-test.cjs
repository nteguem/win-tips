const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const catchAsync = require('../src/utils/catchAsync');
const errors = require('../src/utils/AppError');

function load(relative, dependencies) {
  const filename = path.join(__dirname, '../src', relative), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename, timeout: 1000 });
  return module.exports;
}

function harness() {
  const calls = [];
  const rows = [
    { msgId: 'QA_MESSAGE', deviceId: 'QA_OTHER_DEVICE', appId: 'wintips', status: 'sent' },
    { msgId: 'QA_MESSAGE', deviceId: 'QA_OWNER_DEVICE', appId: 'predictfoot', status: 'sent' },
    { msgId: 'QA_OTHER_MESSAGE', deviceId: 'QA_OWNER_DEVICE', appId: 'wintips', status: 'sent' },
    // A native ACK may arrive before the provider response changes queued.
    { msgId: 'QA_MESSAGE', deviceId: 'QA_OWNER_DEVICE', appId: 'wintips', status: 'queued' }
  ];
  const service = load('api/services/common/deviceService.js', {
    '../../models/common/Device': {}, '../../../utils/AppError': errors,
    './devicePreferences': { preferences() { throw new Error('Registration is outside this test'); } },
    '../push/appContext': { appId: () => 'wintips' },
    '../../models/common/PushDelivery': { async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      const row = rows.find(value => Object.entries(filter).every(([key, expected]) => value[key] === expected));
      if (!row) return null;
      Object.assign(row, update.$set);
      return row;
    } }
  });
  return { service, calls, rows };
}

test('ACK binds exact message + device + server application, including queued deliveries', async () => {
  const h = harness();
  const result = await h.service.ackDelivery({ msgId: 'QA_MESSAGE', deviceId: 'QA_OWNER_DEVICE', appId: 'predictfoot' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].filter)), {
    msgId: 'QA_MESSAGE', deviceId: 'QA_OWNER_DEVICE', appId: 'wintips'
  });
  assert.equal(result, h.rows[3]);
  assert.equal(result.status, 'acked');
  assert.ok(Number.isFinite(result.ackAt.getTime()));
  assert.deepEqual(h.rows.slice(0, 3).map(row => row.status), ['sent', 'sent', 'sent']);
  assert.equal(h.calls[0].options.new, true);
  assert.equal(Object.hasOwn(h.calls[0].filter, 'status'), false);
});

test('valid ACK replay only reaffirms its own delivery without creating a record', async () => {
  const h = harness();
  const input = { msgId: 'QA_MESSAGE', deviceId: 'QA_OWNER_DEVICE' };
  const first = await h.service.ackDelivery(input), again = await h.service.ackDelivery(input);
  assert.equal(first, again);
  assert.equal(again.status, 'acked');
  assert.equal(h.calls.length, 2);
  assert.equal(h.rows.length, 4);
  assert.deepEqual(h.rows.slice(0, 3).map(row => row.status), ['sent', 'sent', 'sent']);
});

test('wrong message/device pair cannot acknowledge another device or application', async () => {
  const h = harness();
  const result = await h.service.ackDelivery({ msgId: 'QA_MESSAGE', deviceId: 'QA_UNRELATED_DEVICE' });
  assert.equal(result, null);
  assert.deepEqual(h.rows.map(row => row.status), ['sent', 'sent', 'sent', 'queued']);
});

test('object/array injection, blanks and oversized identifiers make zero database calls', async () => {
  const invalid = [null, undefined, [], {},
    { msgId: { $ne: null }, deviceId: 'QA_OWNER_DEVICE' },
    { msgId: ['QA_MESSAGE'], deviceId: 'QA_OWNER_DEVICE' },
    { msgId: 'QA_MESSAGE', deviceId: { $ne: null } },
    { msgId: 'QA_MESSAGE', deviceId: ['QA_OWNER_DEVICE'] },
    { msgId: 'QA_MESSAGE', deviceId: 42 },
    { msgId: '', deviceId: 'QA_OWNER_DEVICE' },
    { msgId: ' ', deviceId: 'QA_OWNER_DEVICE' },
    { msgId: 'QA_MESSAGE', deviceId: '\n' },
    { msgId: 'x'.repeat(129), deviceId: 'QA_OWNER_DEVICE' },
    { msgId: 'QA_MESSAGE', deviceId: 'x'.repeat(257) }
  ];
  const h = harness();
  for (const data of invalid) assert.equal(await h.service.ackDelivery(data), null);
  assert.deepEqual(h.calls, []);
});

test('identifier bounds remain usable at their exact maximum', async () => {
  const h = harness();
  await h.service.ackDelivery({ msgId: 'm'.repeat(128), deviceId: 'd'.repeat(256) });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].filter.msgId.length, 128);
  assert.equal(h.calls[0].filter.deviceId.length, 256);
});

test('public ACK route keeps tolerant 204 for invalid/missing bodies with zero database calls', async () => {
  const h = harness();
  const controller = load('api/controllers/common/deviceController.js', {
    '../../services/common/deviceService': h.service, '../../../utils/catchAsync': catchAsync
  });
  let authCalls = 0;
  const router = load('api/routes/common/deviceRoutes.js', {
    express, '../../controllers/common/deviceController': controller,
    '../../middlewares/user/userAuth': { protect(req, res, next) { authCalls++; next(new Error('ACK must stay public')); } }
  });
  const app = express(); app.use(express.json()); app.use('/api/devices', router);
  for (const body of [undefined, {}, [], { msgId: { $ne: null }, deviceId: 'QA_OWNER_DEVICE' },
    { msgId: 'QA_MESSAGE', deviceId: [] }]) {
    const call = request(app).post('/api/devices/ack');
    const res = await (body === undefined ? call : call.send(body));
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
  }
  assert.deepEqual(h.calls, []);
  assert.equal(authCalls, 0);
});
