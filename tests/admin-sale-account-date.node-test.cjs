'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Synthetic identities only; no model initialization, database or credentials.
const saleDate = new Date('2026-11-26T13:00:00Z');
const accountDate = new Date('2025-05-08T07:30:00Z');

function controllerFor(user) {
  const file = path.resolve(__dirname, '../src/api/controllers/admin/subscriptionController.js');
  const module = { exports: {} };
  let projected;
  const mocks = {
    '../../models/common/Subscription': {
      aggregate: async pipeline => {
        const lookup = pipeline.find(stage => stage.$lookup?.from === 'users');
        assert.equal(lookup.$lookup.localField, 'user');
        assert.equal(lookup.$lookup.foreignField, '_id');
        const facet = pipeline.find(stage => stage.$facet).$facet;
        projected = facet.data.find(stage => stage.$project).$project;
        // Model Mongo's requested nested projection, including a missing user.
        const projectedUser = user && Object.fromEntries(Object.entries(user)
          .filter(([field]) => projected['user.' + field] === 1));
        return [{ data: [{ _id: 'synthetic-sale', createdAt: saleDate,
          pricing: { amount: 1000, currency: 'XAF' }, user: projectedUser }], total: [{ count: 1 }] }];
      },
    },
    '../../../utils/catchAsync': handler => handler,
    '../../../utils/currency': { toXAF: amount => amount },
  };
  const load = vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
  load(name => {
    assert.ok(Object.hasOwn(mocks, name), 'Unexpected dependency');
    return mocks[name];
  }, module, module.exports);
  return { handler: module.exports.getSubscriptions, projection: () => projected };
}

async function listing(user) {
  const loaded = controllerFor(user);
  let body;
  await loaded.handler({ query: {} }, {
    status(code) { assert.equal(code, 200); return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(body.success, true);
  return { sale: body.data.subscriptions[0], projection: loaded.projection() };
}

test('sales expose account creation separately from the purchase date without exposing credentials', async () => {
  const { sale } = await listing({ _id: 'synthetic-user', createdAt: accountDate,
    password: 'synthetic-private-field', refreshTokens: ['synthetic-private-field'] });
  assert.equal(sale.user.createdAt, accountDate);
  assert.equal(sale.createdAt, saleDate);
  assert.notEqual(sale.user.createdAt, sale.createdAt);
  assert.equal(Object.hasOwn(sale.user, 'password'), false);
  assert.equal(Object.hasOwn(sale.user, 'refreshTokens'), false);
});

test('a historical sale whose user was removed remains visible', async () => {
  const { sale } = await listing(null);
  assert.equal(sale.user, null);
  assert.equal(sale.createdAt, saleDate);
});
