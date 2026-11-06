'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const express = require('express');
const request = require('supertest');
const { publicIp, requestIp, fetchJson, lookupCountry, createRequestCountryService, createAutoConfigHandler } =
  require('../src/api/services/common/requestCountryConfigService');

const publicRequest = (ip = '8.8.8.8', headers = {}) => ({ socket: { remoteAddress: ip }, headers });
const proxyRequest = headers => publicRequest('::ffff:127.0.0.1', headers);
const configs = {
  CM: { countryCode: 'CM', countryName: 'Cameroun', currency: 'XAF', language: 'fr', phonePrefix: '+237', paymentProvider: 'afribapay' },
  US: { countryCode: 'US', countryName: 'United States', currency: 'USD', language: 'en', phonePrefix: '+1', paymentProvider: 'googlepay' }
};
const service = options => createRequestCountryService({ lookup: async () => ({ country: 'CM' }),
  readConfig: async code => configs[code], ...options });
function load(relative, mocks) {
  const module = { exports: {} };
  const file = path.resolve(__dirname, '..', relative);
  const factory = vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
  factory(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}

test('only public IPv4/IPv6 are eligible; mapped IPv4 and IPv6 canonical forms are supported', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '195.24.192.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.ok(publicIp(ip));
  assert.equal(publicIp('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(publicIp('2001:4860:4860:0:0:0:0:8888'), '2001:4860:4860::8888');
  for (const ip of [null, '', ' 8.8.8.8', '8.8.8.8, 1.1.1.1', '8.8.8.8:80', '[2001:4860::1]',
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.16.1.2', '192.168.1.2',
    '192.0.2.1', '198.18.1.2', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fe80::1', 'fe80::1%eth0', '2001:db8::1', '2001:0db8:0:0::1', '3fff::1',
    '2001:4860::1%eth0', '::ffff:127.0.0.1', '999.1.2.3']) assert.equal(publicIp(ip), null, String(ip));
});

test('public peers cannot spoof X-Real-IP, XFF, Cloudflare, query or body country/IP', () => {
  const req = publicRequest('8.8.8.8', { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '195.24.192.1',
    'cf-connecting-ip': '195.24.192.1' });
  req.ip = '195.24.192.1'; req.query = { country: 'CM', ip: '195.24.192.1' }; req.body = req.query;
  assert.equal(requestIp(req), '8.8.8.8');
});

test('only exact loopback peers use the single nginx-overwritten X-Real-IP; no XFF/CF fallback', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(requestIp(publicRequest(peer, {
    'x-real-ip': '8.8.8.8', 'x-forwarded-for': '195.24.192.1', 'cf-connecting-ip': '195.24.192.1' })), '8.8.8.8');
  for (const headers of [{}, { 'x-forwarded-for': '8.8.8.8' }, { 'cf-connecting-ip': '8.8.8.8' },
    { 'x-real-ip': '8.8.8.8, 1.1.1.1' }, { 'x-real-ip': ['8.8.8.8', '1.1.1.1'] }, { 'x-real-ip': '127.0.0.1' }]) {
    assert.equal(requestIp(proxyRequest(headers)), null);
  }
  assert.equal(requestIp(publicRequest('10.0.0.1', { 'x-real-ip': '8.8.8.8' })), null);
});

test('server country lookup uses HTTPS, bounded alternative, ISO-2 normalization and IPv6 encoding', async () => {
  const calls = [];
  const result = await lookupCountry('2001:4860:4860::8888', async (url, timeout) => {
    calls.push({ url, timeout });
    if (calls.length === 1) throw Error('mobile-provider-like outage');
    return { success: true, country_code: 'cm', city: 'Douala' };
  });
  assert.deepEqual(result, { country: 'CM', city: 'Douala' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.startsWith('https://') && call.timeout === 1500));
  assert.ok(calls[0].url.includes('2001%3A4860%3A4860%3A%3A8888'));
});

test('invalid country/provider success/HTML city is rejected without inventing a country', async () => {
  for (const response of [{ country: 'Cameroon' }, { country: 'XX' }, { country: 'ZZ' }, { country: {} }]) {
    let calls = 0;
    const found = await lookupCountry('8.8.8.8', async () => ++calls === 1 ? response : { success: true, country_code: 'US', city: '<html>' });
    assert.deepEqual(found, { country: 'US', city: undefined });
  }
  await assert.rejects(lookupCountry('8.8.8.8', async () => ({ success: false, country_code: 'CM' })), { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
});

test('native HTTPS downloader rejects redirects, malformed/large responses and enforces an absolute timeout', async t => {
  let mode = 'redirect', destroyed = 0;
  t.mock.method(https, 'get', (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { destroyed++; req.emit('error', Error('destroyed')); };
    if (mode !== 'timeout') queueMicrotask(() => {
      const res = new EventEmitter(); res.setEncoding = () => {}; res.resume = () => {}; res.destroy = () => {};
      res.statusCode = mode === 'redirect' ? 302 : 200;
      callback(res);
      if (res.statusCode === 200) {
        res.emit('data', mode === 'large' ? 'x'.repeat(16385) : mode === 'bad-json' ? '{broken' : '{"country":"CM"}');
        res.emit('end');
      }
    });
    return req;
  });
  for (mode of ['redirect', 'large', 'bad-json', 'timeout']) await assert.rejects(fetchJson('https://api.country.is/8.8.8.8', 20), { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
  assert.ok(destroyed >= 2);
  mode = 'valid'; assert.deepEqual(await fetchJson('https://api.country.is/8.8.8.8', 20), { country: 'CM' });
});

test('detected country reads an existing config and returns only the mobile allowlist with optional city', async () => {
  const countries = [];
  const actual = await service({ lookup: async () => ({ country: 'US', city: 'Mountain View' }), readConfig: async code => {
    countries.push(code); return { ...configs.US, _id: 'private', metadata: { secret: 'no' } };
  } }).getConfig(publicRequest());
  assert.deepEqual(countries, ['US']);
  assert.deepEqual(actual, { ...configs.US, city: 'Mountain View' });
});

test('no eligible IP, unknown/inactive country or invalid config never becomes a hardcoded fallback', async () => {
  let lookups = 0;
  const lookup = async () => { lookups++; return { country: 'CM' }; };
  await assert.rejects(service({ lookup }).getConfig(proxyRequest({})), { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
  assert.equal(lookups, 0);
  for (const value of [null, { ...configs.CM, isActive: false }, configs.US, { ...configs.CM, language: 'xx' }, { ...configs.CM, currency: '' }]) {
    await assert.rejects(service({ readConfig: async () => value }).getConfig(publicRequest()), { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
  }
});

test('short bounded memory cache coalesces concurrent lookups, expires and evicts without persisting IPs', async () => {
  let instant = 0, calls = 0, release;
  const provider = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = service({ lookup: provider, now: () => instant, cacheTtlMs: 10, maxEntries: 1 });
  const a = first.getConfig(publicRequest()), b = first.getConfig(publicRequest());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release({ country: 'CM' }); await Promise.all([a, b]);
  await first.getConfig(publicRequest()); assert.equal(calls, 1);
  instant = 11;
  const c = first.getConfig(publicRequest()); await new Promise(resolve => setImmediate(resolve));
  release({ country: 'CM' }); await c; assert.equal(calls, 2);
  const d = first.getConfig(publicRequest('1.1.1.1')); await new Promise(resolve => setImmediate(resolve));
  release({ country: 'CM' }); await d;
  const e = first.getConfig(publicRequest()); await new Promise(resolve => setImmediate(resolve));
  release({ country: 'CM' }); await e; assert.equal(calls, 4);
});

test('outstanding provider admission and slow Mongo reads are bounded and fail closed', async () => {
  let release;
  const first = service({ maxInFlight: 1, lookup: () => new Promise(resolve => { release = resolve; }) });
  const pending = first.getConfig(publicRequest()); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(first.getConfig(publicRequest('1.1.1.1')), { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
  release({ country: 'CM' }); await pending;
  const slow = service({ readConfig: () => new Promise(() => {}), maxInFlight: 1 });
  const read = slow.getConfig(publicRequest()); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(slow.getConfig(publicRequest()), { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
  await assert.rejects(read, { code: 'COUNTRY_DETECTION_UNAVAILABLE' });
});

test('actual config router serves /auto before /:countryCode and public GET cannot invoke existing POST autocreation', async () => {
  const handler = createAutoConfigHandler({ service: service({ lookup: async ip => ({ country: ip === '8.8.8.8' ? 'US' : 'CM' }) }) });
  let postCalls = 0, countryCalls = 0;
  const controller = load('src/api/controllers/common/configController.js', {
    '../../services/common/configService': { getConfigByIp: async () => { postCalls++; throw Error('unexpected write-capable route'); } },
    '../../../utils/catchAsync': fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
    '../../../utils/AppError': { AppError: Error },
    '../../../utils/responseFormatter': { formatSuccess: () => {} },
    '../../services/common/requestCountryConfigService': { createAutoConfigHandler: () => handler }
  });
  controller.getConfigByCountryCode = (_req, res) => { countryCalls++; res.json({ existing: true }); };
  const router = load('src/api/routes/common/configRoutes.js', {
    '../../controllers/common/configController': controller,
    '../../middlewares/admin/adminAuth': { protect: (_req, _res, next) => next() }
  });
  const app = express(); app.use('/api/config', router);
  const result = await request(app).get('/api/config/auto?country=CM&ip=195.24.192.1')
    .set('X-Real-IP', '8.8.8.8').set('X-Forwarded-For', '195.24.192.1').set('CF-Connecting-IP', '195.24.192.1');
  assert.equal(result.status, 200); assert.deepEqual(result.body.data, configs.US);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(postCalls, 0); assert.equal(countryCalls, 0);
  assert.equal((await request(app).get('/api/config/CM')).status, 200); assert.equal(countryCalls, 1);
});

test('HTTP failures do not disclose IP/provider/DB messages and are never cached', async () => {
  const app = express(); app.get('/api/config/auto', createAutoConfigHandler({ service: { getConfig: async () => { throw Error('private IP + provider/DB detail'); } } }));
  const result = await request(app).get('/api/config/auto');
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { success: false, code: 'COUNTRY_DETECTION_UNAVAILABLE' });
  assert.equal(result.headers['cache-control'], 'private, no-store');
});

test('production config reader filters active existing country and never calls any create/update path', async () => {
  let filter, creates = 0;
  const model = { findOne(value) { filter = value; return { select() { return this; }, maxTimeMS(value) { assert.equal(value, 1000); return this; }, lean: async () => configs.CM }; }, create() { creates++; throw Error('write'); } };
  const api = load('src/api/services/common/requestCountryConfigService.js', { '../../models/common/AppConfig': model });
  const data = await api.createRequestCountryService({ lookup: async () => ({ country: 'CM' }) }).getConfig(publicRequest());
  assert.deepEqual(filter, { countryCode: 'CM', isActive: true }); assert.equal(creates, 0); assert.deepEqual(data, configs.CM);
});
