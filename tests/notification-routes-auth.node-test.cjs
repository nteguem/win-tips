const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { AppError, ErrorCodes } = require('../src/utils/AppError');
const catchAsync = require('../src/utils/catchAsync');

// Real Express, JWT validation and existing admin middleware. Only persistence
// and controllers are simulated; no bootstrap, push service or credentials load.
const secrets = Object.freeze({
  JWT_ADMIN_SECRET: 'QA_ONLY_ADMIN_SECRET_NOT_A_DEPLOYMENT_CREDENTIAL',
  JWT_USER_SECRET: 'QA_ONLY_USER_SECRET_NOT_A_DEPLOYMENT_CREDENTIAL'
});
const routeCases = [
  ['post', '/send', 'send'],
  ['post', '/broadcast', 'broadcast'],
  ['post', '/send-with-filters', 'sendWithFilters'],
  ['post', '/check-players', 'checkPlayers'],
  ['get', '/active-players', 'getActivePlayers']
];
const token = (id, type = 'admin', options = {}) => jwt.sign({ id, type },
  type === 'user' ? secrets.JWT_USER_SECRET : secrets.JWT_ADMIN_SECRET,
  { expiresIn: '5m', ...options });

function load(relative, dependencies, extras = {}) {
  const filename = path.join(__dirname, '../src', relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, ...extras,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename, timeout: 1000 });
  return module.exports;
}

function harness() {
  const calls = [], adminLookups = [];
  const authService = load('api/services/common/authService.js', {
    jsonwebtoken: jwt, '../../../utils/AppError': { AppError, ErrorCodes }
  }, { process: { env: secrets } });
  const adminAuth = load('api/middlewares/admin/adminAuth.js', {
    '../../models/admin/Admin': { async findById(id) {
      adminLookups.push(id);
      if (id === 'QA_ACTIVE_ADMIN') return { id, isActive: true };
      if (id === 'QA_DISABLED_ADMIN') return { id, isActive: false };
      return null;
    } },
    '../../services/common/authService': authService,
    '../../../utils/AppError': { AppError, ErrorCodes },
    '../../../utils/catchAsync': catchAsync
  });
  const controller = Object.fromEntries(routeCases.map(([, , name]) => [name,
    (req, res) => {
      calls.push({ name, adminId: req.admin?.id, body: req.body, query: req.query });
      res.status(200).json({ success: true, controller: name, adminId: req.admin?.id });
    }]));
  const router = load('api/routes/common/notificationRoutes.js', {
    express, '../../controllers/common/notificationController': controller,
    '../../middlewares/admin/adminAuth': adminAuth
  });
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', router);
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({ success: false, errorCode: error.errorCode || 'QA_ERROR' });
  });
  return { app, calls, adminLookups };
}

for (const [method, route, controller] of routeCases) {
  test(`${method.toUpperCase()} ${route}: absent admin token cannot reach controller`, async () => {
    const h = harness();
    const res = await request(h.app)[method]('/api/notifications' + route).send({ notification: { contents: { fr: 'QA_ONLY' } } });
    assert.equal(res.status, 401);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.adminLookups, []);
  });

  test(`${method.toUpperCase()} ${route}: ordinary user JWT cannot reach controller`, async () => {
    const h = harness();
    const res = await request(h.app)[method]('/api/notifications' + route)
      .set('Authorization', 'Bearer ' + token('QA_USER', 'user'));
    assert.equal(res.status, 401);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.adminLookups, []);
  });

  test(`${method.toUpperCase()} ${route}: active admin retains access and request contract`, async () => {
    const h = harness();
    const body = { playerIds: ['QA_ONLY'], notification: { contents: { fr: 'QA_ONLY' } } };
    const res = await request(h.app)[method]('/api/notifications' + route + '?limit=1&offset=0')
      .set('Authorization', 'Bearer ' + token('QA_ACTIVE_ADMIN')).send(body);
    assert.equal(res.status, 200);
    assert.equal(res.body.controller, controller);
    assert.equal(res.body.adminId, 'QA_ACTIVE_ADMIN');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].name, controller);
    assert.deepEqual(h.calls[0].body, body);
    assert.equal(h.calls[0].query.limit, '1');
    assert.deepEqual(h.adminLookups, ['QA_ACTIVE_ADMIN']);
  });
}

for (const scenario of [
  ['expired admin', () => token('QA_ACTIVE_ADMIN', 'admin', { expiresIn: -1 })],
  ['invalid token', () => 'QA_INVALID_TOKEN'],
  ['deleted admin', () => token('QA_DELETED_ADMIN')],
  ['disabled admin', () => token('QA_DISABLED_ADMIN')]
]) {
  test(`broadcast rejects ${scenario[0]} without calling its controller`, async () => {
    const h = harness();
    const res = await request(h.app).post('/api/notifications/broadcast')
      .set('Authorization', 'Bearer ' + scenario[1]()).send({ notification: { contents: { fr: 'QA_ONLY' } } });
    assert.equal(res.status, 401);
    assert.deepEqual(h.calls, []);
  });
}
