const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const transport = require('../src/core/sports/providers/sportsApiTransport');

test('production RapidAPI-only configuration preserves every original endpoint and header', () => {
  for (const [sport, [legacy]] of Object.entries(transport.HOSTS)) {
    const config = transport.transportFor(sport, { RAPID_API_KEY: 'fixture-rapid' });
    assert.equal(config.baseUrl, 'https://' + legacy);
    assert.deepEqual(transport.headersFor(config), { 'x-rapidapi-key': 'fixture-rapid', 'x-rapidapi-host': new URL(config.baseUrl).hostname });
  }
});
test('API-Sports-only configuration and an explicit selector preserve the main migration', () => {
  for (const [sport, [, direct]] of Object.entries(transport.HOSTS)) {
    const config = transport.transportFor(sport, { API_SPORTS_KEY: 'fixture-direct' });
    assert.equal(config.baseUrl, 'https://' + direct); assert.deepEqual(transport.headersFor(config), { 'x-apisports-key': 'fixture-direct' });
  }
  assert.equal(transport.transportFor('football', { SPORTS_API_PROVIDER: 'api-sports', RAPID_API_KEY: 'fixture-rapid', API_SPORTS_KEY: 'fixture-direct' }).apiKey, 'fixture-direct');
  assert.equal(transport.transportFor('football', { RAPID_API_KEY: 'fixture-rapid', API_SPORTS_KEY: 'fixture-direct' }).apiKey, 'fixture-rapid');
});
test('invalid selector, unsupported sport or missing selected key never silently routes elsewhere', () => {
  assert.throws(() => transport.transportFor('football', { SPORTS_API_PROVIDER: 'typo' }));
  assert.throws(() => transport.transportFor('unknown', {}));
  const config = transport.transportFor('football', { SPORTS_API_PROVIDER: 'api-sports', RAPID_API_KEY: 'fixture-rapid' });
  assert.equal(config.apiKey, undefined); assert.throws(() => transport.headersFor(config));
  assert.throws(() => transport.headersFor({ apiKey: 'fixture', baseUrl: 'https://unexpected.example' }));
});
test('all seven actual providers send coherent headers through the injected HTTP client in both modes', async () => {
  for (const sport of Object.keys(transport.HOSTS)) {
    const filename = sport[0].toUpperCase() + sport.slice(1) + 'Provider.js';
    const file = path.join(__dirname, '../src/core/sports/providers', filename), module = { exports: {} };
    class Base { constructor(config, deps) { Object.assign(this, config, deps); } handleApiError(error) { return error; } }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: key => {
      if (key === './SportProvider') return Base;
      if (key === './sportsApiTransport') return transport;
      throw new Error('Unexpected provider dependency');
    } });
    for (const mode of ['rapidapi', 'api-sports']) {
      const requests = [], config = transport.transportFor(sport, { SPORTS_API_PROVIDER: mode, RAPID_API_KEY: 'fixture-rapid', API_SPORTS_KEY: 'fixture-direct' });
      const provider = new module.exports(config, { logger: { info() {} }, httpClient: { get: async (url, options) => { requests.push({ url, options }); return {}; } } });
      await provider.fetchFixtures('2026-10-23'); assert.equal(requests.length, 1);
      assert.ok(requests[0].url.startsWith(config.baseUrl + '/'));
      assert.deepEqual(requests[0].options.headers, transport.headersFor(config));
    }
  }
});
