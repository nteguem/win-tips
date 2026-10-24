const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AppError, ErrorCodes } = require('../src/utils/AppError');
const catchAsync = require('../src/utils/catchAsync');

const packageId = '000000000000000000000001';
const documentId = Object.freeze({ toString: () => packageId });

function controller({ found = true, linked = null, lookupError = null } = {}) {
  const calls = [], exports = {};
  const Package = {
    async findById(value) { calls.push(['findPackage', value]); return found ? { _id: documentId } : null; },
    async findByIdAndDelete(value) { calls.push(['deletePackage', value]); return { _id: documentId }; },
  };
  const Subscription = {
    collection: { async findOne(filter, options) {
      calls.push(['findHistory', filter, options]);
      assert.deepEqual(Object.keys(filter), ['package']); assert.equal(filter.package, documentId);
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { projection: { _id: 1 }, maxTimeMS: 5000 });
      if (lookupError) throw lookupError;
      return linked;
    } },
    find() { throw new Error('MUST_NOT_USE_DATE_FILTERED_FIND'); },
    findOne() { throw new Error('MUST_NOT_USE_ODM_FIND_ONE'); },
  };
  const dependencies = {
    '../../models/common/Package': Package,
    '../../models/common/Formation': {},
    '../../models/common/Category': {},
    '../../models/common/Subscription': Subscription,
    '../../../utils/AppError': { AppError, ErrorCodes },
    '../../../utils/catchAsync': catchAsync,
    '../../services/common/packagePricing': require('../src/api/services/common/packagePricing'),
  };
  const file = path.join(__dirname, '../src/api/controllers/admin/packageController.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require(name) {
    if (!Object.hasOwn(dependencies, name)) throw new Error('UNMOCKED_DEPENDENCY');
    return dependencies[name];
  } }, { filename: file });
  return { controller: exports, calls };
}

function invoke(handler) {
  return new Promise((resolve, reject) => {
    let status = 200;
    handler({ params: { id: packageId } }, { status(value) { status = value; return this; },
      json(body) { resolve({ status, body }); } }, reject);
  });
}

for (const state of ['active', 'expired', 'cancelled']) {
  test(`a linked ${state} subscription prevents physical deletion and recommends deactivation`, async () => {
    const { controller: api, calls } = controller({ linked: { _id: 'TEST_ONLY_SUBSCRIPTION', status: state, endDate: new Date('2020-01-01T00:00:00Z') } });
    await assert.rejects(invoke(api.deletePackage), error => {
      assert.ok(error instanceof AppError); assert.equal(error.statusCode, 409);
      assert.equal(error.errorCode, ErrorCodes.OPERATION_NOT_ALLOWED);
      assert.match(error.message, /Désactivez-le/); assert.match(error.message, /droits achetés/); return true;
    });
    assert.deepEqual(calls.map(row => row[0]), ['findPackage', 'findHistory']);
  });
}

test('an unlinked package retains its original successful deletion response', async () => {
  const { controller: api, calls } = controller();
  const result = await invoke(api.deletePackage);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 200, body: { success: true, message: 'Package supprimé avec succès' } });
  assert.deepEqual(calls.map(row => row[0]), ['findPackage', 'findHistory', 'deletePackage']);
  assert.equal(calls[2][1], packageId);
});

test('a missing package retains its 404 response and does not query history or delete', async () => {
  const { controller: api, calls } = controller({ found: false });
  await assert.rejects(invoke(api.deletePackage), error => error.statusCode === 404 && error.errorCode === ErrorCodes.NOT_FOUND);
  assert.deepEqual(calls.map(row => row[0]), ['findPackage']);
});

test('history lookup failure is forwarded and blocks deletion without a success response', async () => {
  const failure = new Error('TEST_ONLY_DATABASE_UNAVAILABLE');
  const { controller: api, calls } = controller({ lookupError: failure });
  await assert.rejects(invoke(api.deletePackage), error => error === failure);
  assert.deepEqual(calls.map(row => row[0]), ['findPackage', 'findHistory']);
});
