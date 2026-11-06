'use strict';

// Shared allowlist: never persist arbitrary SDK messages or request metadata.
const contract = require('../../docs/ad-telemetry-contract.json');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SLUG = /^[a-z][a-z0-9_.-]{0,63}$/;
const TECH = /^[A-Za-z][A-Za-z0-9_.$-]{0,159}$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,31}$/;
// Dart DateTime.toIso8601String emits up to six fractional digits. Mongo/JS
// store milliseconds, so microseconds are accepted and consistently truncated.
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DAY_MS = 86400000;
const VALID_APP = /^[a-z][a-z0-9_-]{0,39}$/;

class TelemetryValidationError extends Error {
  constructor(statusCode = 400) {
    super('Invalid ad telemetry request');
    this.statusCode = statusCode;
    this.code = 'AD_TELEMETRY_INVALID';
  }
}
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function member(field, value) { return contract[field].includes(value); }
function integer(value, max) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function text(value, regex) { return typeof value === 'string' && regex.test(value); }

function normalizeEvent(input, now = Date.now()) {
  if (!plain(input) || !text(input.eventId, UUID) || !text(input.attemptId, UUID) ||
      !member('types', input.type) || !member('formats', input.format) ||
      !member('platforms', input.platform) || !text(input.placement, SLUG) ||
      !text(input.occurredAt, UTC)) return null;
  const occurredAt = new Date(input.occurredAt);
  const stamp = occurredAt.getTime();
  // Date.parse normalizes impossible dates (e.g. Feb 30); reject them explicitly.
  if (!Number.isFinite(stamp) || occurredAt.toISOString().slice(0, 19) !== input.occurredAt.slice(0, 19) ||
      stamp < now - contract.maxAgeHours * 3600000 || stamp > now + contract.futureToleranceMinutes * 60000) return null;
  const result = { eventId: input.eventId.toLowerCase(), attemptId: input.attemptId.toLowerCase(),
    type: input.type, format: input.format, placement: input.placement, platform: input.platform, occurredAt };
  const optional = (name, valid) => {
    if (input[name] === undefined || input[name] === null) return true;
    if (!valid(input[name])) return false;
    result[name] = input[name];
    return true;
  };
  if (!optional('appVersion', v => text(v, VERSION)) ||
      !optional('country', v => text(v, /^[A-Z]{2}$/)) ||
      !optional('durationMs', v => integer(v, 300000)) ||
      !optional('errorOrigin', v => member('errorOrigins', v)) ||
      !optional('errorCode', v => (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) || text(v, /^[A-Za-z0-9_:-]{1,40}$/)) ||
      !optional('errorDomain', v => text(v, /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/)) ||
      !optional('adapterClassName', v => text(v, TECH)) ||
      !optional('reason', v => member('reasons', v)) ||
      !optional('connectionType', v => member('connectionTypes', v))) return null;
  if ((result.errorCode !== undefined || result.errorDomain !== undefined) && !result.errorOrigin) return null;
  if (['load_failure', 'show_failure'].includes(result.type) && !result.errorOrigin) return null;
  if (result.type === 'paid') {
    if (!integer(input.revenueMicros, 1000000000000) || !text(input.currencyCode, /^[A-Z]{3}$/) ||
        !member('precisionTypes', input.precisionType)) return null;
    result.revenueMicros = input.revenueMicros;
    result.currencyCode = input.currencyCode;
    result.precisionType = input.precisionType;
  }
  return result;
}

function normalizeBatch(body, now = Date.now(), rawBytes) {
  let bytes;
  try { bytes = rawBytes ?? Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { throw new TelemetryValidationError(); }
  if (bytes > contract.maxBodyBytes) throw new TelemetryValidationError(413);
  if (!plain(body) || body.schemaVersion !== contract.schemaVersion || !Array.isArray(body.events) ||
      !body.events.length || body.events.length > contract.maxBatchSize) throw new TelemetryValidationError();
  const events = [], seen = new Set();
  let rejected = 0, duplicates = 0;
  for (const raw of body.events) {
    const event = normalizeEvent(raw, now);
    if (!event) { rejected++; continue; }
    if (seen.has(event.eventId)) { duplicates++; continue; }
    seen.add(event.eventId);
    events.push(event);
  }
  return { events, rejected, duplicates };
}

function dateOnly(value) {
  if (!text(value, /^\d{4}-\d{2}-\d{2}$/)) throw new TelemetryValidationError();
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TelemetryValidationError();
  return parsed;
}
function summaryFilters(query = {}, { appId = null, fixedAppId = null, now = Date.now() } = {}) {
  const today = dateOnly(new Date(now).toISOString().slice(0, 10)).getTime();
  const end = query.to === undefined ? today + DAY_MS : dateOnly(query.to).getTime() + DAY_MS;
  const start = query.from === undefined ? end - 7 * DAY_MS : dateOnly(query.from).getTime();
  if (end <= start || end - start > 14 * DAY_MS || start > now || end > today + DAY_MS ||
      start < today - 14 * DAY_MS) throw new TelemetryValidationError();
  const tenant = fixedAppId || appId;
  if (query.appId !== undefined && (!text(query.appId, VALID_APP) || (tenant && query.appId !== tenant))) throw new TelemetryValidationError();
  const match = { occurredAt: { $gte: new Date(start), $lt: new Date(end) } };
  if (tenant || query.appId) match.appId = tenant || query.appId;
  const patterns = { country: /^[A-Z]{2}$/, placement: SLUG, appVersion: VERSION };
  for (const [key, regex] of Object.entries(patterns)) {
    if (query[key] !== undefined) {
      if (!text(query[key], regex)) throw new TelemetryValidationError();
      match[key] = query[key];
    }
  }
  if (query.format !== undefined) {
    if (!member('formats', query.format)) throw new TelemetryValidationError();
    match.format = query.format;
  }
  return { match, from: new Date(start), toExclusive: new Date(end) };
}

function summaryPipeline(match) {
  const boundedGroups = fields => [
    { $group: { _id: fields, count: { $sum: 1 }, averageDurationMs: { $avg: '$durationMs' },
      maximumDurationMs: { $max: '$durationMs' } } },
    { $sort: { count: -1, '_id.type': 1 } }, { $limit: 200 }
  ];
  return [{ $match: match }, { $facet: {
    lifecycle: boundedGroups({ appId: '$appId', format: '$format', type: '$type' }),
    failures: [{ $match: { type: { $in: ['load_failure', 'show_failure'] } } }, ...boundedGroups({
      appId: '$appId', format: '$format', type: '$type', errorOrigin: '$errorOrigin',
      errorCode: '$errorCode', errorDomain: '$errorDomain', reason: '$reason', connectionType: '$connectionType' })],
    placements: boundedGroups({ appId: '$appId', format: '$format', placement: '$placement', type: '$type' }),
    countries: boundedGroups({ appId: '$appId', country: '$country', type: '$type' }),
    versions: boundedGroups({ appId: '$appId', appVersion: '$appVersion', type: '$type' }),
    adapters: boundedGroups({ appId: '$appId', adapterClassName: '$adapterClassName', format: '$format', type: '$type' }),
    reportedRevenue: [{ $match: { type: 'paid' } }, { $group: {
      _id: { appId: '$appId', format: '$format', currencyCode: '$currencyCode', precisionType: '$precisionType' },
      paidEvents: { $sum: 1 }, revenueMicros: { $sum: '$revenueMicros' }
    } }, { $sort: { paidEvents: -1 } }, { $limit: 200 }]
  } }];
}

module.exports = { contract, TelemetryValidationError, normalizeEvent, normalizeBatch, summaryFilters, summaryPipeline };
