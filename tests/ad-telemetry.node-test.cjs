'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const { contract, normalizeEvent, normalizeBatch, summaryFilters, summaryPipeline } = require('../src/core/adTelemetry');
const { createTelemetryService } = require('../src/api/services/common/adTelemetryService');
const { createPublicRouter, createAdminRouter } = require('../src/api/routes/common/adTelemetryRoutes');
const now = Date.parse('2026-11-05T12:00:00.000Z');
function event(extra = {}) {
  return { eventId: randomUUID(), attemptId: randomUUID(), type: 'load_success', format: 'rewarded',
    placement: 'free_coupon', occurredAt: new Date(now).toISOString(), platform: 'android', ...extra };
}
function envelope(...events) { return { schemaVersion: 1, events }; }
function memoryStore() {
  const saved = new Map(), aggregates = [];
  return { saved, aggregates,
    async bulkWrite(ops, options) {
      assert.equal(options.maxTimeMS, 3000); assert.equal(options.ordered, false);
      let upsertedCount = 0;
      for (const op of ops) {
        const { filter, update, upsert } = op.updateOne;
        assert.equal(upsert, true);
        const key = filter.appId + ':' + filter.eventId;
        if (!saved.has(key)) { saved.set(key, update.$setOnInsert); upsertedCount++; }
      }
      return { upsertedCount };
    },
    aggregate(pipeline) {
      aggregates.push(pipeline);
      return { async option(opts) { assert.equal(opts.maxTimeMS, 3000); return [{ lifecycle: [] }]; } };
    }
  };
}
function harness({ fixedAppId, model = memoryStore(), limit, parseGlobally = false } = {}) {
  const app = express();
  if (parseGlobally) app.use(express.json({ limit: '10mb', verify(req, _res, buffer) { req.rawBody = buffer.toString('utf8'); } }));
  const service = createTelemetryService({ model, now: () => now });
  const identifyApp = (req, res, next) => {
    const id = req.get('X-App-Id');
    if (!['bigwin', 'goatips'].includes(id)) return res.status(400).json({ success: false });
    req.appId = id; next();
  };
  app.use('/api/ads/telemetry', createPublicRouter({
    service, ...(fixedAppId ? { fixedAppId } : { identifyApp }),
    ...(limit ? { limiter: require('express-rate-limit')({ windowMs: 60000, limit,
      standardHeaders: true, legacyHeaders: false, message: { success: false, code: 'AD_TELEMETRY_RATE_LIMIT' } }) } : {})
  }));
  const auth = (req, res, next) => req.get('Authorization') === 'Bearer test-admin' ? next() : res.sendStatus(401);
  app.use('/api/admin/ads/telemetry', auth, (req, _res, next) => { req.appId = req.get('X-App-Id'); next(); },
    createAdminRouter({ service, fixedAppId }));
  return { app, model, service };
}

test('machine contract enumerations are accepted without manufacturing missing context', () => {
  for (const type of contract.types) {
    const extra = type.endsWith('failure') ? { errorOrigin: 'sdk', errorCode: 2, errorDomain: 'com.google.android.gms.ads' } : {};
    if (type === 'paid') Object.assign(extra, { revenueMicros: 123, currencyCode: 'EUR', precisionType: 'publisher_provided' });
    const result = normalizeEvent(event({ type, ...extra }), now);
    assert.equal(result.type, type);
    assert.equal(result.country, undefined); assert.equal(result.appVersion, undefined);
    assert.equal(result.connectionType, undefined);
  }
  for (const reason of contract.reasons) assert.equal(normalizeEvent(event({ type: 'show_skipped', reason }), now).reason, reason);
  for (const connectionType of contract.connectionTypes) assert.equal(normalizeEvent(event({ connectionType }), now).connectionType, connectionType);
});

test('SDK failure details remain technical and distinct from local timeouts and skipped VIP', () => {
  const sdk = normalizeEvent(event({ type: 'load_failure', errorOrigin: 'sdk', errorCode: 2,
    errorDomain: 'com.google.android.gms.ads', durationMs: 2500 }), now);
  assert.equal(sdk.errorCode, 2); assert.equal(sdk.errorOrigin, 'sdk');
  const local = normalizeEvent(event({ type: 'load_failure', errorOrigin: 'local', reason: 'timeout', durationMs: 15000 }), now);
  assert.equal(local.reason, 'timeout'); assert.equal(local.errorCode, undefined);
  const skipped = normalizeEvent(event({ type: 'load_skipped', reason: 'vip' }), now);
  assert.equal(skipped.type, 'load_skipped'); assert.equal(skipped.errorOrigin, undefined);
  assert.equal(normalizeEvent(event({ type: 'load_failure' }), now), null);
});

test('PII, nonce, response info, free-form messages and revenue outside paid are never retained', () => {
  const result = normalizeEvent(event({ token: 'secret', deviceId: 'device', userId: 'person', email: 'x@y.z',
    ip: '127.0.0.1', errorMessage: 'Sensitive SDK response', stackTrace: 'secret', ssvNonce: 'nonce',
    adUnitId: 'pub-unit', responseInfo: { secret: 'response' }, revenueMicros: 999, currencyCode: 'EUR' }), now);
  for (const key of [...contract.forbiddenData, 'responseInfo', 'revenueMicros', 'currencyCode']) assert.equal(result[key], undefined);
});

test('paid callback requires a real bounded integer amount and explicit currency/precision', () => {
  const paid = { type: 'paid', revenueMicros: 15000, currencyCode: 'USD', precisionType: 'estimated' };
  assert.equal(normalizeEvent(event(paid), now).revenueMicros, 15000);
  for (const extra of [{ revenueMicros: -1 }, { revenueMicros: 0.5 }, { revenueMicros: 1e12 + 1 },
    { currencyCode: 'usd' }, { currencyCode: '$' }, { precisionType: 'fake' }, { revenueMicros: undefined }]) {
    assert.equal(normalizeEvent(event({ ...paid, ...extra }), now), null);
  }
});

test('validation rejects malformed or identifying values rather than retaining unbounded dimensions', () => {
  for (const bad of [null, [], 'x', { eventId: 'not-a-uuid' }, { attemptId: 'user@example.com' }, { placement: 'Coupon title / user' },
    { placement: 'x'.repeat(65) }, { type: 'grant_credit' }, { format: 'unknown' }, { platform: 'desktop' }, { appVersion: 'x'.repeat(33) },
    { country: 'Cameroon' }, { country: 'cm' }, { durationMs: -1 }, { durationMs: 300001 }, { durationMs: 1.5 },
    { reason: 'raw exception message' }, { connectionType: 'sensitive SSID' }, { errorOrigin: 'backend' },
    { errorOrigin: 'sdk', errorCode: { message: 'secret' } }, { errorOrigin: 'sdk', errorCode: 'secret with spaces' },
    { errorOrigin: 'sdk', errorDomain: 'https://secret.example/token' }, { adapterClassName: 'SDK <raw message>' }]) {
    assert.equal(normalizeEvent(bad === null || Array.isArray(bad) || typeof bad === 'string' ? bad : event(bad), now), null);
  }
});

test('timestamps are UTC, bounded and calendar-valid; rejected entries do not block valid ones', () => {
  for (const occurredAt of ['2026-11-04T11:59:59Z', '2026-11-05T12:05:01Z', '2026-11-05T13:00:00+01:00',
    '2026-02-30T12:00:00Z', 'invalid']) assert.equal(normalizeEvent(event({ occurredAt }), now), null);
  assert.ok(normalizeEvent(event({ occurredAt: '2026-11-04T12:00:00Z' }), now));
  const good = event();
  const parsed = normalizeBatch(envelope(good, { ...good }, event({ country: 'invalid' })), now);
  assert.equal(parsed.events.length, 1); assert.equal(parsed.duplicates, 1); assert.equal(parsed.rejected, 1);
});

test('Dart UTC microsecond timestamps preserve the UTC instant to Mongo/JS millisecond precision', () => {
  const stamp = '2026-11-05T12:00:00.123456Z';
  const normalized = normalizeEvent(event({ occurredAt: stamp }), now);
  assert.ok(normalized);
  assert.equal(normalized.occurredAt.getTime(), now + 123);
  assert.equal(normalized.occurredAt.toISOString(), '2026-11-05T12:00:00.123Z');
  for (const fraction of ['1', '12', '123', '1234', '12345', '123456', '999999']) {
    const instant = normalizeEvent(event({ occurredAt: '2026-11-05T12:00:00.' + fraction + 'Z' }), now);
    assert.ok(instant, fraction);
    assert.equal(instant.occurredAt.getTime(), now + Number((fraction + '000').slice(0, 3)));
  }
  assert.equal(normalizeEvent(event({ occurredAt: '2026-11-05T12:00:00.1234567Z' }), now), null);
  assert.equal(normalizeEvent(event({ occurredAt: '2026-02-30T12:00:00.123456Z' }), now), null);
});

test('real SDK-style mobile failure and paid fields survive a batch with Dart dates and build version', () => {
  const sdkFailure = event({ type: 'load_failure', occurredAt: '2026-11-05T12:00:00.234567Z',
    errorOrigin: 'sdk', errorCode: 2, errorDomain: 'com.google.android.gms.ads',
    adapterClassName: 'com.google.ads.mediation.admob.AdMobAdapter',
    appVersion: '1.5.0+30', connectionType: 'mobile', country: 'CM', durationMs: 1587 });
  const paid = event({ type: 'paid', occurredAt: '2026-11-05T12:00:00.987654Z',
    revenueMicros: 12500, currencyCode: 'EUR', precisionType: 'publisher_provided', appVersion: '1.5.0+30' });
  const result = normalizeBatch(envelope(sdkFailure, paid), now);
  assert.equal(result.events.length, 2); assert.equal(result.rejected, 0);
  assert.equal(result.events[0].errorCode, 2);
  assert.equal(result.events[0].errorDomain, 'com.google.android.gms.ads');
  assert.equal(result.events[0].appVersion, '1.5.0+30');
  assert.equal(result.events[1].currencyCode, 'EUR');
  assert.equal(result.events[1].precisionType, 'publisher_provided');
  assert.equal(result.events[1].revenueMicros, 12500);
});

test('envelope limits enforce version, nonempty batch, at most 20 and at most 32 KiB', () => {
  for (const body of [undefined, {}, { schemaVersion: 2, events: [event()] }, envelope(), envelope(...Array.from({ length: 21 }, () => event()))]) {
    assert.throws(() => normalizeBatch(body, now), error => error.statusCode === 400);
  }
  assert.equal(normalizeBatch(envelope(...Array.from({ length: 20 }, () => event())), now).events.length, 20);
  assert.throws(() => normalizeBatch({ ...envelope(event()), ignored: 'x'.repeat(32768) }, now), error => error.statusCode === 413);
});

test('storage is idempotent across retries and separated by tenant, with server-generated TTL only', async () => {
  const model = memoryStore(), service = createTelemetryService({ model, now: () => now });
  const e = event({ appId: 'forged', expiresAt: '2099-01-01' }), body = envelope(e);
  assert.deepEqual(await service.ingest({ appId: 'bigwin', body }), { accepted: 1, duplicates: 0, rejected: 0 });
  assert.deepEqual(await service.ingest({ appId: 'bigwin', body }), { accepted: 0, duplicates: 1, rejected: 0 });
  assert.equal((await service.ingest({ appId: 'goatips', body })).accepted, 1);
  assert.equal(model.saved.size, 2);
  const stored = [...model.saved.values()][0];
  assert.equal(stored.appId, 'bigwin'); assert.equal(stored.expiresAt.getTime(), now + 14 * 86400000);
  assert.equal(stored.receivedAt.getTime(), now);
});

test('concurrent duplicate-key races are counted, while write concern and storage outages remain retryable', async () => {
  const body = envelope(event(), event());
  const race = Object.assign(Error('duplicate'), { writeErrors: [{ code: 11000 }], result: { upsertedCount: 1 } });
  const service = createTelemetryService({ model: { bulkWrite: async () => { throw race; } }, now: () => now });
  assert.deepEqual(await service.ingest({ appId: 'bigwin', body }), { accepted: 1, duplicates: 1, rejected: 0 });
  for (const error of [Error('secret Mongo URI'), Object.assign(Error(), { writeErrors: [{ code: 42 }] }),
    Object.assign(Error(), { writeErrors: [{ code: 11000 }], writeConcernErrors: [{ code: 64 }] })]) {
    const failed = createTelemetryService({ model: { bulkWrite: async () => { throw error; } }, now: () => now });
    await assert.rejects(failed.ingest({ appId: 'bigwin', body }), error);
  }
});

test('unique and TTL indexes must be ready before ingestion and a failed index build is retried', async () => {
  const model = memoryStore(); let attempts = 0, ready = false;
  const originalWrite = model.bulkWrite;
  model.createIndexes = async () => { attempts++; if (attempts === 1) throw Error('index unavailable'); ready = true; };
  model.bulkWrite = (...args) => { assert.equal(ready, true); return originalWrite(...args); };
  const service = createTelemetryService({ model, now: () => now });
  await assert.rejects(service.ingest({ appId: 'bigwin', body: envelope(event()) }), /index unavailable/);
  assert.equal(model.saved.size, 0);
  await service.ingest({ appId: 'bigwin', body: envelope(event()) });
  await service.ingest({ appId: 'bigwin', body: envelope(event()) });
  assert.equal(attempts, 2); assert.equal(model.saved.size, 2);
});

test('public endpoint accepts guest observations and preserves tenant from middleware, not payload', async () => {
  const { app, model } = harness();
  const result = await request(app).post('/api/ads/telemetry/batch').set('X-App-Id', 'bigwin')
    .send({ ...envelope(event({ appId: 'goatips', type: 'reward' })), appId: 'goatips' }).expect(202);
  assert.deepEqual(result.body.data, { accepted: 1, duplicates: 0, rejected: 0 });
  assert.equal([...model.saved.values()][0].appId, 'bigwin');
  assert.equal([...model.saved.values()][0].type, 'reward', 'reward remains diagnostic data only');
  await request(app).post('/api/ads/telemetry/batch').send(envelope(event())).expect(400);
  assert.equal(model.saved.size, 1);
});

test('slow storage has a bounded response deadline and admission stays closed until an ambiguous operation settles', async () => {
  let release, calls = 0;
  const unresolved = new Promise(resolve => { release = resolve; });
  const service = createTelemetryService({ now: () => now, storageTimeoutMs: 10, maxInFlight: 1,
    model: { bulkWrite() { calls++; return calls === 1 ? unresolved : Promise.resolve({ upsertedCount: 1 }); } } });
  const body = envelope(event());
  await assert.rejects(service.ingest({ appId: 'bigwin', body }), /timeout/);
  await assert.rejects(service.ingest({ appId: 'bigwin', body }), /busy/);
  assert.equal(calls, 1, 'timeouts must not create unbounded background database calls');
  release({ upsertedCount: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.ingest({ appId: 'bigwin', body: envelope(event()) })).accepted, 1);
});

test('single-app endpoint is fixed to wintips and ignores forged tenant values', async () => {
  const { app, model } = harness({ fixedAppId: 'wintips' });
  await request(app).post('/api/ads/telemetry/batch').set('X-App-Id', 'bigwin').send(envelope(event({ appId: 'bigwin' }))).expect(202);
  assert.equal([...model.saved.values()][0].appId, 'wintips');
});

test('route rejects oversized bodies with and without the existing global parser', async () => {
  for (const parseGlobally of [false, true]) {
    const { app, model } = harness({ fixedAppId: 'wintips', parseGlobally });
    await request(app).post('/api/ads/telemetry/batch').send({ ...envelope(event()), ignored: 'x'.repeat(32768) }).expect(413);
    assert.equal(model.saved.size, 0);
  }
});

test('route returns 429 before persistence and does not interfere with unavailable ad navigation', async () => {
  const { app, model } = harness({ fixedAppId: 'wintips', limit: 1 });
  await request(app).post('/api/ads/telemetry/batch').send(envelope(event())).expect(202);
  const response = await request(app).post('/api/ads/telemetry/batch').send(envelope(event())).expect(429);
  assert.equal(response.body.code, 'AD_TELEMETRY_RATE_LIMIT'); assert.equal(model.saved.size, 1);
});

test('database outage produces redacted retryable 503 with no credit API or body echoed', async () => {
  const { app } = harness({ fixedAppId: 'wintips', model: { bulkWrite: async () => { throw Error('mongodb://password@example.com'); } } });
  const response = await request(app).post('/api/ads/telemetry/batch').send(envelope(event({ ssvNonce: 'secret' }))).expect(503);
  assert.equal(response.headers['retry-after'], '60');
  assert.deepEqual(response.body, { success: false, code: 'AD_TELEMETRY_UNAVAILABLE' });
  assert.equal(JSON.stringify(response.body).includes('secret'), false);
});

test('malformed JSON and all-invalid observations are handled without arbitrary messages', async () => {
  const { app } = harness({ fixedAppId: 'wintips' });
  await request(app).post('/api/ads/telemetry/batch').set('Content-Type', 'application/json').send('{oops').expect(400);
  const response = await request(app).post('/api/ads/telemetry/batch').send(envelope({ token: 'secret' })).expect(202);
  assert.deepEqual(response.body.data, { accepted: 0, duplicates: 0, rejected: 1 });
});

test('summary enforces UTC date bounds, fixed tenants and safe dimension filters', () => {
  const result = summaryFilters({ from: '2026-11-01', to: '2026-11-05', format: 'rewarded', country: 'CM' }, { appId: 'bigwin', now });
  assert.equal(result.match.appId, 'bigwin'); assert.equal(result.match.country, 'CM');
  assert.equal(result.from.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(result.toExclusive.toISOString(), '2026-11-06T00:00:00.000Z');
  for (const query of [{ appId: 'other' }, { from: '2026-10-01' }, { from: '2026-11-06' }, { to: '2026-11-07' },
    { from: '2026-11-30' }, { country: { $ne: 'CM' } }, { appVersion: { $where: 'x' } }, { format: 'bogus' }]) {
    assert.throws(() => summaryFilters(query, { fixedAppId: 'wintips', now }), error => error.statusCode === 400);
  }
});

test('summary pipeline bounds every section, separates revenue currencies, and does not infer devices or DAU', () => {
  const filters = summaryFilters({}, { appId: 'bigwin', now });
  const pipeline = summaryPipeline(filters.match), facet = pipeline[1].$facet;
  assert.equal(pipeline[0].$match.appId, 'bigwin');
  for (const section of Object.values(facet)) assert.equal(section.at(-1).$limit, 200);
  assert.equal(facet.reportedRevenue[1].$group._id.currencyCode, '$currencyCode');
  const serialized = JSON.stringify(pipeline);
  for (const invalid of ['deviceId', 'userId', '$addToSet', 'retention', 'DAU']) assert.equal(serialized.includes(invalid), false);
});

test('admin summary requires auth, validates tenant override, and labels client revenue accurately', async () => {
  const { app, model } = harness({ fixedAppId: 'wintips' });
  await request(app).get('/api/admin/ads/telemetry/summary').expect(401);
  await request(app).get('/api/admin/ads/telemetry/summary?appId=bigwin').set('Authorization', 'Bearer test-admin').expect(400);
  const result = await request(app).get('/api/admin/ads/telemetry/summary?from=2026-11-01&to=2026-11-05')
    .set('Authorization', 'Bearer test-admin').expect(200);
  assert.equal(model.aggregates[0][0].$match.appId, 'wintips');
  assert.equal(result.body.data.revenueSource, 'client_reported_not_accounting');
  assert.equal(result.body.data.audienceMetrics, 'not_available_no_persistent_user_identifier');
});

test('Mongoose schema keeps bounded retention and idempotency indexes with buffering disabled, without any connection', () => {
  const Model = require('../src/api/models/common/AdTelemetryEvent');
  const indexes = Model.schema.indexes();
  assert.ok(indexes.some(([keys, opts]) => keys.appId === 1 && keys.eventId === 1 && opts.unique));
  assert.ok(indexes.some(([keys, opts]) => keys.expiresAt === 1 && opts.expireAfterSeconds === 0));
  assert.equal(Model.schema.options.bufferCommands, false);
  assert.equal(Model.db.readyState, 0);
  assert.equal(Model.schema.path('userId'), undefined); assert.equal(Model.schema.path('deviceId'), undefined);
});

test('real API mount graph protects summary with admin auth/role and keeps guest ingestion available', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/api/routes/index.js'), 'utf8');
  const multiTenant = source.includes('ADMIN_SUPER');
  const model = memoryStore(), service = createTelemetryService({ model, now: () => now });
  const module = { exports: {} };
  const noop = (_req, _res, next) => next();
  const unrelated = new Proxy(noop, { get: () => noop });
  const protect = (req, res, next) => {
    if (req.get('Authorization') !== 'Bearer test-admin') return res.sendStatus(401);
    req.admin = { role: req.get('X-Admin-Role') || 'super_admin' }; return next();
  };
  const identify = (required) => (req, res, next) => {
    const appId = req.get('X-App-Id');
    if (required && !['bigwin', 'goatips'].includes(appId)) return res.sendStatus(400);
    req.appId = appId || null; return next();
  };
  vm.runInNewContext(source, { module, process: { env: {} }, require(name) {
    if (name === 'express') return express;
    if (name === '../middlewares/admin/adminAuth') return { protect };
    if (name === '../middlewares/admin/rbac') return {
      authorize: (...roles) => (req, res, next) => roles.includes(req.admin?.role) ? next() : res.sendStatus(403),
      enforceAppScope: noop, readOnly: noop
    };
    if (name === '../middlewares/common/appIdentifier') return { identifyApp: identify(true), identifyAppOptional: identify(false) };
    if (name === './common/adTelemetryRoutes') return {
      createPublicRouter: options => createPublicRouter({ ...options, service }),
      createAdminRouter: options => createAdminRouter({ ...options, service })
    };
    return unrelated;
  } });
  const app = express(); app.use(express.json()); app.use('/api', module.exports);
  await request(app).get('/api/admin/ads/telemetry/summary').expect(401);
  if (multiTenant) {
    await request(app).get('/api/admin/ads/telemetry/summary').set('Authorization', 'Bearer test-admin')
      .set('X-Admin-Role', 'pronostiqueur').expect(403);
  }
  const response = await request(app).get('/api/admin/ads/telemetry/summary').set('Authorization', 'Bearer test-admin').expect(200);
  assert.equal(response.body.data.revenueSource, 'client_reported_not_accounting');
  const ingest = request(app).post('/api/ads/telemetry/batch');
  if (multiTenant) ingest.set('X-App-Id', 'bigwin');
  await ingest.send(envelope(event())).expect(202);
  assert.equal(model.saved.size, 1);
});

test('Google-signed SSV with a third-party mediation network verifies; changing network bytes invalidates it', async () => {
  const module = { exports: {} }, key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = key.publicKey.export({ type: 'spki', format: 'pem' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/services/common/admobSsvService.js'), 'utf8'), {
    module, exports: module.exports, Buffer, URLSearchParams, Date, Map, process: { env: {} },
    require(name) {
      if (name === 'crypto' || name === 'node:crypto') return require('node:crypto');
      if (name === 'axios') return { async get() { return { data: { keys: [{ keyId: 42, pem }] } }; } };
      if (name.endsWith('/logger')) return { warn() {}, error() {}, info() {} };
      throw Error('Unexpected dependency ' + name);
    }
  });
  const signed = 'ad_network=third_party_mediation_network&ad_unit=unit&custom_data=' +
    encodeURIComponent(JSON.stringify({ nonce: 'example-not-production' })) + '&transaction_id=mediated-1&timestamp=1793880000000';
  const query = signed + '&signature=' + sign('sha256', Buffer.from(signed), key.privateKey).toString('base64url') + '&key_id=42';
  const verified = await module.exports.verifyCallback(query);
  assert.equal(verified.valid, true); assert.equal(verified.params.adNetwork, 'third_party_mediation_network');
  assert.equal((await module.exports.verifyCallback(query.replace('third_party_mediation_network', 'tampered_network'))).valid, false);
});
