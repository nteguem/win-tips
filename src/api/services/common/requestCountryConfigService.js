'use strict';

const https = require('node:https');
const net = require('node:net');

const unavailable = () => Object.assign(new Error('Country detection unavailable'), {
  code: 'COUNTRY_DETECTION_UNAVAILABLE'
});
const countryCode = value => typeof value === 'string' && /^[a-z]{2}$/i.test(value) &&
  !['XX', 'ZZ'].includes(value.toUpperCase()) ? value.toUpperCase() : null;

function publicIp(value) {
  if (typeof value !== 'string' || value.length > 64 || /[%\s,\[\]]/.test(value)) return null;
  const normalized = value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  const version = net.isIP(normalized);
  if (version === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
        a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
        a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) ||
        a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
        a === 203 && b === 0 && c === 113) return null;
    return normalized;
  }
  // Accept globally routed unicast only, excluding documentation ranges.
  if (version === 6) {
    const canonical = new URL('https://[' + normalized + ']/').hostname.slice(1, -1);
    if (/^[23]/i.test(canonical) && !/^2001:db8(?::|$)/i.test(canonical) &&
        !/^3fff(?::|$)/i.test(canonical)) return canonical;
  }
  return null;
}

function requestIp(req) {
  const peer = req.socket?.remoteAddress;
  const localProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  // Production nginx overwrites X-Real-IP with $remote_addr. Its real-IP module
  // accepts CF-Connecting-IP only from its configured Cloudflare CIDRs. Never
  // trust a public socket's headers, arbitrary XFF, or CF-Connecting-IP here.
  return publicIp(localProxy ? req.headers?.['x-real-ip'] : peer);
}

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0, body = '', timer;
    const finish = (error, data) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(unavailable()); else resolve(data);
    };
    const req = https.get(url, { headers: { Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { finish(unavailable()); res.destroy(); req.destroy(); return; }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16384) { finish(unavailable()); res.destroy(); req.destroy(); return; }
        body += chunk;
      });
      res.on('error', () => finish(unavailable()));
      res.on('end', () => {
        try { finish(null, JSON.parse(body)); } catch (_) { finish(unavailable()); }
      });
    });
    timer = setTimeout(() => { finish(unavailable()); req.destroy(); }, timeoutMs);
    req.on('error', () => finish(unavailable()));
  });
}

async function lookupCountry(ip, fetch = fetchJson) {
  const encoded = encodeURIComponent(ip);
  const providers = [
    { url: 'https://api.country.is/' + encoded, parse: value => ({ country: countryCode(value?.country) }) },
    { url: 'https://ipwho.is/' + encoded + '?fields=success,country_code,city', parse: value => ({
      country: value?.success === true ? countryCode(value.country_code) : null,
      city: typeof value?.city === 'string' && value.city.length <= 120 && !/[<>\x00-\x1f\x7f]/.test(value.city)
        ? value.city.trim() : undefined
    }) }
  ];
  for (const provider of providers) {
    try {
      const result = provider.parse(await fetch(provider.url, 1500));
      if (result.country) return result;
    } catch (_) { /* One bounded alternative, without exposing IPs or errors. */ }
  }
  throw unavailable();
}

async function readExistingConfig(code) {
  return require('../../models/common/AppConfig').findOne({ countryCode: code, isActive: true })
    .select('countryCode countryName currency language phonePrefix paymentProvider -_id').maxTimeMS(1000).lean();
}

function createRequestCountryService({ lookup = lookupCountry, readConfig = readExistingConfig,
    now = Date.now, cacheTtlMs = 300000, maxEntries = 1024, maxInFlight = 8 } = {}) {
  // Short-lived bounded process memory only: never persist an IP or create a
  // country in Mongo from this public GET endpoint.
  const cache = new Map(), pending = new Map();
  let activeReads = 0;
  const boundedRead = code => new Promise((resolve, reject) => {
    if (activeReads >= maxInFlight) { reject(unavailable()); return; }
    activeReads++;
    const timer = setTimeout(() => reject(unavailable()), 1200);
    Promise.resolve().then(() => readConfig(code)).then(resolve, reject)
      .finally(() => { clearTimeout(timer); activeReads--; });
  });
  return {
    async getConfig(req) {
      const ip = requestIp(req);
      if (!ip) throw unavailable();
      let detection = cache.get(ip);
      if (!detection || detection.expiresAt <= now()) {
        cache.delete(ip);
        let job = pending.get(ip);
        if (!job) {
          if (pending.size >= maxInFlight) throw unavailable();
          job = Promise.resolve().then(() => lookup(ip)).then(value => {
            const country = countryCode(value?.country);
            if (!country) throw unavailable();
            const entry = { country, city: value.city, expiresAt: now() + cacheTtlMs };
            while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
            cache.set(ip, entry);
            return entry;
          }).finally(() => pending.delete(ip));
          pending.set(ip, job);
        }
        detection = await job;
      }
      const config = await boundedRead(detection.country);
      if (!config || config.isActive === false || config.countryCode !== detection.country) throw unavailable();
      const result = {};
      for (const field of ['countryCode', 'countryName', 'currency', 'language', 'phonePrefix', 'paymentProvider']) {
        if (typeof config[field] !== 'string' || !config[field].trim()) throw unavailable();
        result[field] = config[field];
      }
      if (!['fr', 'en'].includes(result.language) || !/^[A-Z]{3}$/.test(result.currency)) throw unavailable();
      if (detection.city) result.city = detection.city;
      return result;
    }
  };
}

function createAutoConfigHandler({ service = createRequestCountryService() } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.status(200).json({ success: true, data: await service.getConfig(req) }); }
    catch (_) { res.status(503).json({ success: false, code: 'COUNTRY_DETECTION_UNAVAILABLE' }); }
  };
}

module.exports = { publicIp, requestIp, fetchJson, lookupCountry, createRequestCountryService, createAutoConfigHandler };
