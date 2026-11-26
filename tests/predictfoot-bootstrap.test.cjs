'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../predictfoot.js'), 'utf8');

function load({ dbFailure = false, listenFailure = false } = {}) {
  const calls = [];
  const module = { exports: {} };
  const req = name => {
    if (name === 'dotenv') return { config() { calls.push('environment'); } };
    assert.equal(calls[0], 'environment', 'configuration precedes service import');
    if (name === 'node:dns') return { setDefaultResultOrder(order) { assert.equal(order, 'ipv4first'); } };
    if (name === './src/utils/logger') return { info() {}, error() {} };
    if (name === './config/database') return { async connectDB() { calls.push('database'); if (dbFailure) throw Error('db unavailable'); } };
    if (name === './src/app') return { listen(port, host, ready) {
      calls.push('listen'); assert.equal(port, '4503'); assert.equal(host, '0.0.0.0');
      const server = { once(event, callback) { assert.equal(event, 'error'); if (listenFailure) queueMicrotask(() => callback(Error('port occupied'))); } };
      if (!listenFailure) queueMicrotask(ready);
      return server;
    } };
    if (name.includes('Job')) return { start() { calls.push(name); } };
    throw Error('Unexpected dependency ' + name);
  };
  req.main = {};
  vm.runInNewContext(source, { require: req, module, process: { env: { PORT: '4503' } } });
  return { calls, start: module.exports.startServer };
}

test('Predictfoot loads environment first and starts each payment recovery after DB and HTTP', async () => {
  const { calls, start } = load();
  assert.deepEqual(calls, ['environment']);
  await start();
  assert.deepEqual(calls.slice(0, 3), ['environment', 'database', 'listen']);
  assert.equal(calls.filter(c => c.endsWith('VerificationJob')).length, 4);
  assert.equal(calls.filter(c => c.endsWith('fcmTokenHygieneJob')).length, 1);
});
test('DB failure cannot start recovery or HTTP', async () => {
  const { calls, start } = load({ dbFailure: true });
  await assert.rejects(start(), /db unavailable/);
  assert.deepEqual(calls, ['environment', 'database']);
});
test('HTTP bind failure cannot start payment recovery jobs', async () => {
  const { calls, start } = load({ listenFailure: true });
  await assert.rejects(start(), /port occupied/);
  assert.deepEqual(calls, ['environment', 'database', 'listen']);
});
