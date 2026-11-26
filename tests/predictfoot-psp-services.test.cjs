const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
function query(value) {
  return { populate() { return this; }, sort() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(item => matches(record, item));
    if (value?.$nin) return !value.$nin.includes(record[key]);
    if (value?.$in) return value.$in.includes(record[key]);
    if (value?.$ne !== undefined) return record[key] !== value.$ne;
    if (value?.$exists !== undefined) return (record[key] !== undefined) === value.$exists;
    return String(record[key]) === String(value);
  });
}
function model() {
  const records = new Map();
  const copy = value => value ? Object.assign(Object.create(Model.prototype), value) : null;
  class Model {
    constructor(fields) { Object.assign(this, { _id: crypto.randomBytes(12).toString('hex'), processed: false, createdAt: new Date() }, fields); }
    async save() {
      const idField = this.depositId ? 'depositId' : 'transactionId';
      if ([...records.values()].some(record => record[idField] === this[idField] && record._id !== this._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      records.set(this._id, Object.assign(Object.create(Model.prototype), this)); return this;
    }
    async populate() { return this; }
    static findOne(filter) { return query(copy([...records.values()].find(record => matches(record, filter)))); }
    static findById(id) { return query(copy(records.get(String(id)))); }
    static findOneAndUpdate(filter, update) {
      const record = [...records.values()].find(item => matches(item, filter));
      if (record) Object.assign(record, Object.fromEntries(Object.entries(update.$set || {}).filter(([, value]) => value !== undefined)));
      if (record) for (const [key, increment] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + increment;
      return query(copy(record));
    }
    static async updateOne(filter, update) { await Model.findOneAndUpdate(filter, update); }
  }
  return { Model, records };
}

function harness(provider, options = {}) {
  const { Model, records } = model();
  const env = {
    PAWAPAY_ENVIRONMENT: 'sandbox', PAWAPAY_SANDBOX_TOKEN: 'unit-token',
    CINETPAY_API_URL: options.v1 ? 'https://api.cinetpay.co' : 'https://api-checkout.cinetpay.com',
    CINETPAY_XOF_API_KEY: 'unit-key', CINETPAY_XOF_SITE_ID: 'unit-site',
    CINETPAY_XOF_API_PASSWORD: options.v1 ? 'unit-password' : undefined,
    APP_BASE_URL: 'https://predictfoot.example'
  };
  const calls = [];
  const packageDoc = { _id: '111111111111111111111111', name: { fr: 'Accès test', en: 'Test pass' }, type: 'VIP', duration: 1,
    isActive: true, categories: ['222222222222222222222222'], pricing: new Map([['XOF', 1000], ['XAF', 1000]]) };
  let replyPost = options.post || (async () => ({ data: { status: 'ACCEPTED' } }));
  let replyGet = options.get || (async url => url.includes('active-conf') ? { data: { countries: [{ country: 'COG', providers: [{ provider: 'AIRTEL_COG', currencies: [{ currency: 'XAF', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', minAmount: '100', maxAmount: '5000' } } }] }] }] } } : { data: {} });
  const axios = {
    async post(url, payload, config) { calls.push({ method: 'POST', url, payload, config }); return replyPost(url, payload, config); },
    async get(url, config) { calls.push({ method: 'GET', url, config }); return replyGet(url, config); }
  };
  const moduleCache = new Map();
  function load(filename) {
    const absolute = path.resolve(root, filename);
    if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports;
    const module = { exports: {} }; moduleCache.set(absolute, module);
    const localRequire = dependency => {
      if (dependency === 'axios') return axios;
      if (dependency === 'uuid') return { v4: () => crypto.randomUUID() };
      if (dependency.includes('models/user/')) return Model;
      if (dependency.endsWith('/Package')) return { findById: async () => packageDoc };
      if (dependency.endsWith('/AppError')) return { AppError, ErrorCodes: {} };
      if (dependency.endsWith('/catchAsync')) return callback => callback;
      if (dependency.endsWith('/logger')) return { info() {}, error() {}, warn() {} };
      if (dependency.endsWith('/paymentMiddleware')) return options.middleware || { async processTransactionUpdate() { return null; } };
      if (dependency.endsWith('/subscriptionService')) return { async getActiveSubscriptions() { return []; } };
      if (dependency.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(absolute), dependency + '.js')));
      return require(dependency);
    };
    const context = { module, exports: module.exports, require: localRequire, process: { env },
      console: { log() {}, warn() {}, error() {} }, Buffer, Date, Map, URL, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), context, { filename: absolute });
    return module.exports;
  }
  const service = load(`src/api/services/user/${provider === 'pawa' ? 'Pawapay' : 'Cinetpay'}Service.js`);
  return { service, Model, records, calls, env, packageDoc, load, setPost(value) { replyPost = value; }, setGet(value) { replyGet = value; } };
}

const user = { _id: '333333333333333333333333', pseudo: 'Tester' };
const packageId = '111111111111111111111111';
const reference = 'a4e3b7a8-1397-4327-8c31-2152b8649b15';
const initiatePawa = h => h.service.initiatePayment(user, packageId, '053456789', 'airtel', 'CG', undefined, reference);
const initiateCinet = h => h.service.initiatePayment(user._id, packageId, undefined, 'Tester', 'unit@example.com', 'XOF', reference);

test('pawa keeps significant zero in Congo and Côte d’Ivoire and handles Benin/Gabon national formats', () => {
  const h = harness('pawa');
  for (const [value, country, expected] of [
    ['053456789', 'CG', '242053456789'], ['+242053456789', 'CG', '242053456789'],
    ['0102030405', 'CI', '2250102030405'], ['0197000000', 'BJ', '22997000000'],
    ['+2290197000000', 'BJ', '22997000000'], ['074345678', 'GA', '24174345678'],
    ['0024174345678', 'GA', '24174345678']
  ]) assert.equal(h.service.normalizePhone(value, country), expected);
  assert.equal(h.service.normalizePhone('123', 'CG'), '');
});

test('pawa Airtel provider overrides and numeric catalogue limits', () => {
  const h = harness('pawa');
  for (const [country, suffix] of [['GA', 'GAB'], ['CG', 'COG'], ['CD', 'COD']]) assert.equal(h.service.buildProviderCode(country, 'airtel'), `AIRTEL_${suffix}`);
  const result = h.service.normalizeActiveConf({ countries: [{ country: 'COG', providers: [{ provider: 'AIRTEL_COG', currencies: [{ currency: 'XAF', operationTypes: { DEPOSIT: { minAmount: '0', maxAmount: '5000' } } }] }] }] });
  assert.equal(result.CG.providers[0].minAmount, 0);
  assert.equal(result.CG.providers[0].maxAmount, 5000);
});

test('pawa timeout retains one durable transaction and retry never sends another deposit', async () => {
  const h = harness('pawa', { post: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } });
  const result = await initiatePawa(h);
  assert.equal(result.pending, true); assert.equal(result.transaction.status, 'PENDING');
  assert.equal(h.records.size, 1);
  const again = await initiatePawa(h);
  assert.equal(again.transaction.depositId, result.transaction.depositId);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(result.transaction.paymentSnapshot.amount, 1000);
  assert.equal(result.transaction.paymentSnapshot.packageCouponTypes[0], '222222222222222222222222');
  assert.equal(result.transaction.paymentSnapshot.packageType, 'VIP');
  assert.equal(result.transaction.paymentSnapshot.packageName.en, 'Test pass');
});

test('pawa concurrent duplicate initiations use the existing unique PSP identifier', async () => {
  const h = harness('pawa');
  const results = await Promise.all([initiatePawa(h), initiatePawa(h)]);
  assert.equal(h.records.size, 1);
  assert.equal(results[0].transaction.depositId, results[1].transaction.depositId);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

function pawaReceipt(transaction) {
  return { status: 'FOUND', data: { depositId: transaction.depositId, status: 'COMPLETED', amount: '1000.00', currency: 'XAF',
    payer: { type: 'MMO', accountDetails: { phoneNumber: transaction.phoneNumber, provider: transaction.provider } }, clientReferenceId: transaction.clientReferenceId } };
}

for (const field of ['depositId', 'amount', 'currency', 'provider', 'phone', 'reference']) {
  test(`pawa blocks a settled receipt with mismatching ${field}`, async () => {
    const h = harness('pawa'); const { transaction } = await initiatePawa(h);
    const raw = pawaReceipt(transaction);
    if (field === 'provider') raw.data.payer.accountDetails.provider = 'MTN_MOMO_COG';
    else if (field === 'phone') raw.data.payer.accountDetails.phoneNumber = '242069999999';
    else if (field === 'reference') raw.data.clientReferenceId = 'someone-else';
    else raw.data[field] = field === 'amount' ? '1' : 'mismatch';
    h.setGet(async () => ({ data: raw }));
    await assert.rejects(h.service.checkTransactionStatus(transaction.depositId), /reçu/);
    assert.notEqual([...h.records.values()][0].status, 'SUCCESS');
  });
}

test('pawa verified receipt wins over stale pending/failure observations', async () => {
  const h = harness('pawa'); const { transaction } = await initiatePawa(h);
  h.setGet(async () => ({ data: pawaReceipt(transaction) }));
  assert.equal((await h.service.checkTransactionStatus(transaction.depositId)).status, 'SUCCESS');
  h.setGet(async () => ({ data: { status: 'FOUND', data: { status: 'SUBMITTED' } } }));
  assert.equal((await h.service.checkTransactionStatus(transaction.depositId)).status, 'SUCCESS');
  h.setGet(async () => ({ data: { status: 'FOUND', data: { status: 'FAILED' } } }));
  assert.equal((await h.service.checkTransactionStatus(transaction.depositId)).status, 'SUCCESS');
});

test('pawa definitive rejection is retained as a failure, not reported initiated', async () => {
  const h = harness('pawa', { post: async () => ({ data: { status: 'REJECTED', failureReason: { failureCode: 'PAYER_NOT_FOUND' } } }) });
  const result = await initiatePawa(h);
  assert.equal(result.refused, true); assert.equal(result.transaction.status, 'FAILED'); assert.equal(h.records.size, 1);
});

test('pawa PREAUTH requires the operator code and never persists it', async () => {
  const h = harness('pawa');
  h.setGet(async () => ({ data: { countries: [{ country: 'COG', providers: [{ provider: 'AIRTEL_COG', currencies: [{ currency: 'XAF', operationTypes: { DEPOSIT: { status: 'OPERATIONAL', authType: 'PREAUTH' } } }] }] }] } }));
  await assert.rejects(initiatePawa(h), /code de paiement/);
  assert.equal(h.records.size, 0);
  const result = await h.service.initiatePayment(user, packageId, '053456789', 'airtel', 'CG', undefined, reference, '123456');
  assert.equal(h.calls.find(call => call.method === 'POST').payload.preAuthorisationCode, '123456');
  assert.equal(result.transaction.preAuthorisationCode, undefined);
});

test('pawa PREAUTH rejects malformed codes without starting a payment', async () => {
  const h = harness('pawa');
  await assert.rejects(h.service.initiatePayment(user, packageId, '053456789', 'airtel', 'CG', undefined, reference, 'x'.repeat(37)), /code de paiement/);
  assert.equal(h.calls.some(call => call.method === 'POST'), false);
});

test('CinetPay separates legacy site credentials from OAuth passwords', () => {
  const h = harness('cinet');
  assert.equal(h.service.getAdapter(h.service.getConfig(), 'XOF').apiVersion, 'legacy-v2');
  h.env.CINETPAY_API_URL = 'https://api.cinetpay.co'; h.env.CINETPAY_API_VERSION = 'v1';
  assert.throws(() => h.service.getAdapter(h.service.getConfig(), 'XOF'), error => error.statusCode === 503);
});

test('CinetPay legacy initialization uses v2 fields and stores checkout for a retry', async () => {
  const h = harness('cinet', { post: async () => ({ data: { code: '201', data: { payment_url: 'https://checkout.cinetpay.com/unit', payment_token: 'unit' } } }) });
  const result = await initiateCinet(h); const again = await initiateCinet(h);
  const call = h.calls.find(call => call.method === 'POST');
  assert.equal(call.url, 'https://api-checkout.cinetpay.com/v2/payment');
  assert.equal(call.payload.site_id, 'unit-site'); assert.equal(call.payload.apikey, 'unit-key');
  assert.equal(call.payload.api_password, undefined); assert.equal(call.payload.amount, 1000);
  assert.equal(call.config.httpsAgent.options.family, 4);
  assert.equal(again.paymentUrl, result.paymentUrl); assert.equal(h.calls.length, 1);
});

test('CinetPay timeout retains the attempt for status or webhook recovery', async () => {
  const h = harness('cinet', { post: async () => { throw new Error('socket timeout'); } });
  const result = await initiateCinet(h);
  assert.equal(result.pending, true); assert.equal(h.records.size, 1); assert.equal(result.paymentUrl, null);
  await initiateCinet(h); assert.equal(h.calls.length, 1);
});

test('CinetPay concurrent duplicate initialization sends one checkout request', async () => {
  const h = harness('cinet', { post: async () => ({ data: { code: '201', data: { payment_url: 'https://checkout.cinetpay.com/unit' } } }) });
  const result = await Promise.all([initiateCinet(h), initiateCinet(h)]);
  assert.equal(h.records.size, 1); assert.equal(h.calls.length, 1); assert.equal(result[0].transaction.transactionId, result[1].transaction.transactionId);
});

test('CinetPay legacy check verifies amount and currency before settlement', async () => {
  const h = harness('cinet', { post: async () => ({ data: { code: '201', data: { payment_url: 'https://checkout.cinetpay.com/unit' } } }) });
  const { transaction } = await initiateCinet(h);
  h.setPost(async () => ({ data: { code: '00', data: { status: 'ACCEPTED', amount: 1, currency: 'XOF' } } }));
  await assert.rejects(h.service.checkTransactionStatus(transaction.transactionId), /reçu/);
  assert.notEqual([...h.records.values()][0].status, 'ACCEPTED');
  h.setPost(async () => ({ data: { code: '00', data: { status: 'ACCEPTED', amount: '1000', currency: 'XOF' } } }));
  assert.equal((await h.service.checkTransactionStatus(transaction.transactionId)).status, 'ACCEPTED');
  assert.equal(h.calls.at(-1).payload.transaction_id, transaction.transactionId);
});

test('CinetPay v1 refreshes an expired token once, including a successful HTTP envelope', async () => {
  let tokens = 0; let checks = 0;
  const h = harness('cinet', { v1: true });
  h.setPost(async (url) => url.endsWith('/oauth/login') ? { data: { code: 200, access_token: `unit-${++tokens}` } } : { data: { code: 200, payment_url: 'https://checkout.cinetpay.co/unit', transaction_id: 'PSP-UNIT' } });
  const { transaction } = await initiateCinet(h);
  h.setGet(async () => ++checks === 1 ? { data: { code: 1003, status: 'EXPIRED_TOKEN' } } : { data: { code: 100, status: 'SUCCESS', merchant_transaction_id: transaction.transactionId, transaction_id: 'PSP-UNIT' } });
  assert.equal((await h.service.checkTransactionStatus(transaction.transactionId)).status, 'ACCEPTED');
  assert.equal(tokens, 2); assert.equal(checks, 2);
});

test('CinetPay FAILED/2010 gets grace and later success can activate', async () => {
  const h = harness('cinet', { v1: true });
  h.setPost(async url => ({ data: url.endsWith('/oauth/login') ? { code: 200, access_token: 'unit-token' } : { code: 200, payment_url: 'https://checkout.cinetpay.co/unit', transaction_id: 'PSP-UNIT' } }));
  const { transaction } = await initiateCinet(h);
  h.setGet(async () => ({ data: { code: 2010, status: 'FAILED' } }));
  assert.equal((await h.service.checkTransactionStatus(transaction.transactionId)).status, 'WAITING_FOR_CUSTOMER');
  h.setGet(async () => ({ data: { code: 100, status: 'SUCCESS', merchant_transaction_id: transaction.transactionId, transaction_id: 'PSP-UNIT' } }));
  assert.equal((await h.service.checkTransactionStatus(transaction.transactionId)).status, 'ACCEPTED');
  h.setGet(async () => ({ data: { code: 2010, status: 'FAILED' } }));
  assert.equal((await h.service.checkTransactionStatus(transaction.transactionId)).status, 'ACCEPTED');
});

test('CinetPay v1 rejects a receipt belonging to another merchant transaction', async () => {
  const h = harness('cinet', { v1: true });
  h.setPost(async url => ({ data: url.endsWith('/oauth/login') ? { code: 200, access_token: 'unit-token' } : { code: 200, payment_url: 'https://checkout.cinetpay.co/unit', transaction_id: 'PSP-UNIT' } }));
  const { transaction } = await initiateCinet(h);
  h.setGet(async () => ({ data: { code: 100, status: 'SUCCESS', merchant_transaction_id: 'OTHER', transaction_id: 'PSP-UNIT' } }));
  await assert.rejects(h.service.checkTransactionStatus(transaction.transactionId), /reçu/);
});

test('transaction status ownership is checked before provider requests', async () => {
  const h = harness('pawa'); const { transaction } = await initiatePawa(h);
  const controller = h.load('src/api/controllers/user/paymentTransactionController.js');
  const before = h.calls.length;
  await assert.rejects(controller.verify(h.Model, 'depositId', h.service, transaction.depositId, 'someone-else'), error => error.statusCode === 404);
  assert.equal(h.calls.length, before);
});

test('webhook persists recovery marker before a provider timeout and does not falsely process payment', async () => {
  const h = harness('pawa'); const { transaction } = await initiatePawa(h);
  h.setGet(async () => { assert.equal([...h.records.values()][0].webhookPending, true); throw new Error('timeout'); });
  const controller = h.load('src/api/controllers/user/paymentTransactionController.js');
  const result = await controller.queueWebhook(h.Model, 'depositId', transaction.depositId, h.service);
  assert.equal(result.statusCode, 202); assert.equal([...h.records.values()][0].processed, false); assert.equal([...h.records.values()][0].webhookPending, true);
});

test('mobile transaction contract does not confuse payment acceptance with activation', async () => {
  const h = harness('pawa'); const { transaction } = await initiatePawa(h);
  transaction.status = 'SUCCESS'; transaction.processed = false;
  const safety = h.load('src/api/services/user/paymentTransactionSafety.js');
  let result = safety.publicTransaction(transaction);
  assert.equal(result.transactionId, transaction.depositId); assert.equal(result.packageId, packageId);
  assert.equal(result.processed, false); assert.equal(result.subscriptionId, null);
  transaction.subscriptionId = '444444444444444444444444'; transaction.processed = true;
  result = safety.publicTransaction(transaction); assert.equal(result.subscriptionId, '444444444444444444444444');
});

test('pawa resumes a prepared purchase after process death before the first POST', async () => {
  const h = harness('pawa'); const safety = h.load('src/api/services/user/paymentTransactionSafety.js');
  const transaction = new h.Model({ depositId: safety.referenceId('pawapay', user._id, reference), clientReference: reference,
    clientReferenceId: 'PF-RECOVER', user: user._id, package: packageId, status: 'PENDING', provider: 'AIRTEL_COG',
    phoneNumber: '242053456789', currency: 'XAF', amount: 1000, environment: 'sandbox', initiationPhase: 'PREPARED',
    customerMessage: 'Acces test', paymentSnapshot: safety.snapshot(h.packageDoc, 1000, 'XAF') });
  await transaction.save();
  const result = await initiatePawa(h);
  assert.equal(h.records.size, 1); assert.equal(result.transaction.initiationPhase, 'SUBMITTED');
  assert.equal(h.calls[0].payload.depositId, transaction.depositId);
});

test('pawa NOT_FOUND verification stays read only; an explicit retry reuses the same idempotent deposit', async () => {
  const h = harness('pawa', { post: async () => { throw new Error('socket lost'); } });
  const { transaction } = await initiatePawa(h);
  await h.Model.updateOne({ _id: transaction._id }, { $set: { initiationClaimedAt: new Date(Date.now() - 3 * 60 * 1000) } });
  h.setGet(async () => ({ data: { status: 'NOT_FOUND' } }));
  h.setPost(async () => ({ data: { status: 'ACCEPTED' } }));
  const results = await Promise.all([h.service.checkTransactionStatus(transaction.depositId), h.service.checkTransactionStatus(transaction.depositId)]);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(results.every(result => result.initiationPhase === 'PREPARED' && result.retryable), true);
  const retried = await initiatePawa(h);
  const deposits = h.calls.filter(call => call.method === 'POST');
  assert.equal(deposits.length, 2); // One uncertain call, one explicit user retry.
  assert.equal(deposits[0].payload.depositId, deposits[1].payload.depositId);
  assert.equal(retried.transaction.initiationPhase, 'SUBMITTED');
});

test('CinetPay resumes a prepared checkout under an atomic submission claim', async () => {
  const h = harness('cinet', { v1: true }); const safety = h.load('src/api/services/user/paymentTransactionSafety.js');
  const transaction = new h.Model({ transactionId: safety.referenceId('cinetpay', user._id, reference), clientReference: reference,
    user: user._id, package: packageId, status: 'PENDING', currency: 'XOF', amount: 1000, apiVersion: 'v1',
    customerName: 'Tester', customerEmail: 'unit@example.com', description: 'Accès',
    returnUrl: 'https://predictfoot.example/return', notifyUrl: 'https://predictfoot.example/notify', initiationPhase: 'PREPARED' });
  await transaction.save();
  h.setPost(async url => ({ data: url.endsWith('/oauth/login') ? { code: 200, access_token: 'unit-token' } : { code: 200, payment_url: 'https://checkout.cinetpay.co/unit', transaction_id: 'PSP-UNIT' } }));
  await Promise.all([initiateCinet(h), initiateCinet(h)]);
  const requests = h.calls.filter(call => call.url.endsWith('/v1/payment'));
  assert.equal(requests.length, 1); assert.equal(requests[0].payload.merchant_transaction_id, transaction.transactionId);
  assert.equal(requests[0].payload.channel, 'PUSH'); assert.equal(requests[0].payload.direct_pay, false);
});

test('CinetPay authenticated JSON NOT_FOUND makes the same reference retryable; a proxy 404 does not', async () => {
  const h = harness('cinet', { v1: true });
  h.setPost(async url => url.endsWith('/oauth/login') ? { data: { code: 200, access_token: 'unit-token' } } : Promise.reject(new Error('socket lost')));
  const { transaction } = await initiateCinet(h);
  await h.Model.updateOne({ _id: transaction._id }, { $set: { initiationClaimedAt: new Date(Date.now() - 3 * 60 * 1000) } });
  h.setGet(async () => { throw Object.assign(new Error('proxy'), { response: { status: 404, data: '<html>Not found</html>' } }); });
  await assert.rejects(h.service.checkTransactionStatus(transaction.transactionId), /proxy/);
  assert.equal([...h.records.values()][0].retryable, false);
  h.setGet(async () => { throw Object.assign(new Error('notfound'), { response: { status: 404, data: { code: 404, status: 'NOT_FOUND' } } }); });
  const result = await h.service.checkTransactionStatus(transaction.transactionId);
  assert.equal(result.retryable, true); assert.equal(result.initiationPhase, 'PREPARED');
});

test('CinetPay lost checkout URL exposes an explicit replacement action without creating a checkout', async () => {
  const h = harness('cinet', { v1: true });
  h.setPost(async url => url.endsWith('/oauth/login') ? { data: { code: 200, access_token: 'unit-token' } } : Promise.reject(new Error('socket lost')));
  const { transaction } = await initiateCinet(h);
  await h.Model.updateOne({ _id: transaction._id }, { $set: { initiationClaimedAt: new Date(Date.now() - 3 * 60 * 1000) } });
  h.setGet(async () => ({ data: { code: 201, status: 'INITIATED', merchant_transaction_id: transaction.transactionId, transaction_id: 'PSP-UNIT' } }));
  const before = h.calls.filter(call => call.method === 'POST').length;
  const result = await h.service.checkTransactionStatus(transaction.transactionId);
  assert.equal(result.canStartNewCheckout, true); assert.equal(result.paymentUrl, undefined);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, before);
});

test('CinetPay refuses plaintext transport even for a recognised hostname', () => {
  const h = harness('cinet', { v1: true }); h.env.CINETPAY_API_URL = 'http://api.cinetpay.co';
  assert.throws(() => h.service.getAdapter(h.service.getConfig(), 'XOF'), error => error.statusCode === 503);
});

test('CinetPay replacement rechecks the original payment and delivers it when it settled at the last moment', async () => {
  let h;
  h = harness('cinet', { v1: true, middleware: { async processTransactionUpdate(transaction) {
    if (transaction.status !== 'ACCEPTED') return null;
    await h.Model.updateOne({ _id: transaction._id }, { $set: { processed: true, subscriptionId: '444444444444444444444444' } });
    return { _id: '444444444444444444444444', status: 'active' };
  } } });
  h.setPost(async url => url.endsWith('/oauth/login') ? { data: { code: 200, access_token: 'unit-token' } } : Promise.reject(new Error('socket lost')));
  const { transaction } = await initiateCinet(h);
  await h.Model.updateOne({ _id: transaction._id }, { $set: { initiationClaimedAt: new Date(Date.now() - 3 * 60 * 1000) } });
  h.setGet(async () => ({ data: { code: 100, status: 'SUCCESS', merchant_transaction_id: transaction.transactionId, transaction_id: 'PSP-UNIT' } }));
  const controller = h.load('src/api/controllers/user/cinetpayController.js');
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  const before = h.calls.filter(call => call.method === 'POST').length;
  await controller.initiatePayment({ user, body: { packageId, currency: 'XOF', clientReference: 'b4e3b7a8-1397-4327-8c31-2152b8649b15', restartTransactionId: transaction.transactionId } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.data.transaction.transactionId, transaction.transactionId);
  assert.equal(res.body.data.transaction.processed, true); assert.equal(res.body.data.transaction.subscriptionId, '444444444444444444444444');
  assert.equal(h.records.size, 1); assert.equal(h.calls.filter(call => call.method === 'POST').length, before);
});

test('CinetPay creates a replacement only on an explicit owned request after a fresh unpaid check', async () => {
  const h = harness('cinet', { v1: true });
  h.setPost(async url => url.endsWith('/oauth/login') ? { data: { code: 200, access_token: 'unit-token' } } : Promise.reject(new Error('socket lost')));
  const { transaction } = await initiateCinet(h);
  await h.Model.updateOne({ _id: transaction._id }, { $set: { initiationClaimedAt: new Date(Date.now() - 3 * 60 * 1000) } });
  h.setGet(async () => ({ data: { code: 201, status: 'INITIATED', merchant_transaction_id: transaction.transactionId, transaction_id: 'PSP-UNIT' } }));
  h.setPost(async () => ({ data: { code: 200, payment_url: 'https://checkout.cinetpay.co/new-page', transaction_id: 'PSP-NEW' } }));
  const controller = h.load('src/api/controllers/user/cinetpayController.js');
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  const before = h.calls.filter(call => call.method === 'POST').length;
  await controller.initiatePayment({ user, body: { packageId, currency: 'XOF', clientReference: 'b4e3b7a8-1397-4327-8c31-2152b8649b15', restartTransactionId: transaction.transactionId } }, res);
  assert.equal(res.code, 201); assert.notEqual(res.body.data.transaction.transactionId, transaction.transactionId);
  assert.equal(h.records.size, 2); assert.equal(h.calls.filter(call => call.method === 'POST').length, before + 1);
  assert.equal([...h.records.values()].find(record => record.transactionId !== transaction.transactionId).replacesTransactionId, transaction.transactionId);
  assert.equal([...h.records.values()].find(record => record.transactionId === transaction.transactionId).status, 'INITIATED');
});

test('pawa selects the CDF deposit wallet even when a USD wallet is listed first and hides unsupported redirect auth', () => {
  const h = harness('pawa');
  const result = h.service.normalizeActiveConf({ countries: [{ country: 'COD', providers: [
    { provider: 'AIRTEL_COD', currencies: [
      { currency: 'USD', operationTypes: { DEPOSIT: { minAmount: '1', maxAmount: '100' } } },
      { currency: 'CDF', operationTypes: { DEPOSIT: { minAmount: '1000', maxAmount: '200000' } } }
    ] }, { provider: 'OTHER_COD', currencies: [{ currency: 'CDF', operationTypes: { DEPOSIT: { authType: 'REDIRECT_AUTH' } } }] }
  ] }] });
  assert.equal(result.CD.providers.length, 1); assert.equal(result.CD.providers[0].currency, 'CDF');
  assert.equal(result.CD.providers[0].minAmount, 1000); assert.equal(result.CD.providers[0].maxAmount, 200000);
});
