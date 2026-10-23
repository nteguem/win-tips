const test = require('node:test');
const assert = require('node:assert/strict');

const servicePath = require.resolve('../src/api/services/common/deviceService');
const controllerPath = require.resolve('../src/api/controllers/common/deviceController');

function controllerWith(service) {
  const beforeService = require.cache[servicePath];
  const beforeController = require.cache[controllerPath];
  try {
    require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service };
    delete require.cache[controllerPath];
    return require(controllerPath);
  } finally {
    if (beforeService) require.cache[servicePath] = beforeService;
    else delete require.cache[servicePath];
    if (beforeController) require.cache[controllerPath] = beforeController;
    else delete require.cache[controllerPath];
  }
}

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      send() { resolve({ status: this.statusCode }); return this; }
    };
    try { handler(req, res, reject); } catch (error) { reject(error); }
  });
}

const device = Object.freeze({ deviceId: 'QA_DEVICE_ONLY', language: 'en', editorialSchemaVersion: 1 });

test('device registration keeps its existing successful response contract', async () => {
  const calls = [];
  const controller = controllerWith({ registerDevice: async data => { calls.push(data); return device; } });
  const req = { body: { deviceId: device.deviceId, platform: 'android', language: 'en', editorialSchemaVersion: 1 } };
  const result = await invoke(controller.registerDevice, req);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deviceId, device.deviceId);
  assert.equal(calls[0].language, 'en');
  assert.equal(calls[0].user, null);
  assert.deepEqual(result, { status: 200, body: { success: true, data: device } });
});

const cases = [
  { handler: 'linkDevice', service: 'linkDeviceToUser', req: { body: { deviceId: device.deviceId }, user: { id: 'QA_USER_ONLY' } }, args: [device.deviceId, 'QA_USER_ONLY'] },
  { handler: 'unlinkDevice', service: 'unlinkDeviceFromUser', req: { body: { deviceId: device.deviceId } }, args: [device.deviceId] },
  { handler: 'updateDevice', service: 'updateDevice', req: { params: { deviceId: device.deviceId }, body: { language: 'fr', notificationsEnabled: false } }, args: [device.deviceId, { language: 'fr', notificationsEnabled: false }] },
  { handler: 'deactivateDevice', service: 'deactivateDevice', req: { params: { deviceId: device.deviceId } }, args: [device.deviceId] }
];

for (const scenario of cases) {
  test(`${scenario.handler} responds successfully after the service mutation, exactly once`, async () => {
    const calls = [];
    const controller = controllerWith({ [scenario.service]: async (...args) => { calls.push(args); return device; } });
    const result = await invoke(controller[scenario.handler], scenario.req);
    assert.deepEqual(calls, [scenario.args]);
    assert.deepEqual(result, { status: 200, body: { success: true, data: device } });
  });

  test(`${scenario.handler} forwards a service failure without claiming success`, async () => {
    let calls = 0;
    const failure = Object.assign(new Error('QA_SERVICE_ERROR'), { statusCode: 503 });
    const controller = controllerWith({ [scenario.service]: async () => { calls++; throw failure; } });
    await assert.rejects(invoke(controller[scenario.handler], scenario.req), error => error === failure);
    assert.equal(calls, 1);
  });
}

test('unlink of an already absent device still returns the service null result', async () => {
  let calls = 0;
  const controller = controllerWith({ unlinkDeviceFromUser: async () => { calls++; return null; } });
  const result = await invoke(controller.unlinkDevice, { body: { deviceId: device.deviceId } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 200, body: { success: true, data: null } });
});

test('notification acknowledgement remains tolerant and uses 204 without a device wrapper', async () => {
  const calls = [];
  const controller = controllerWith({ ackDelivery: async data => { calls.push(data); throw new Error('QA_ACK_FAILURE'); } });
  const result = await invoke(controller.ackNotification, { body: { msgId: 'QA_MESSAGE_ONLY', deviceId: device.deviceId } });
  assert.deepEqual(calls, [{ msgId: 'QA_MESSAGE_ONLY', deviceId: device.deviceId }]);
  assert.deepEqual(result, { status: 204 });
});
