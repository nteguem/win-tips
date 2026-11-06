'use strict';
// Durable SSV receipt spool. Independent of Mongo availability; never grants a
// reward until Google verification succeeds. Only terminal receipts are pruned.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_QUERY = 16384;
const ID = /^[a-f0-9]{64}$/;
const error = code => Object.assign(new Error(code), { code });
const missing = err => err?.code === 'ENOENT';
async function processIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const [boot, stat] = await Promise.all([fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readFile(`/proc/${pid}/stat`, 'utf8')]);
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return start ? boot.trim() + ':' + start : null;
  } catch (_) { return null; }
}
function customData(raw) {
  try { return JSON.parse(raw); } catch (_) {}
  try { return JSON.parse(decodeURIComponent(raw)); } catch (_) { return null; }
}
function acceptable(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_QUERY || /[\r\n\0]/.test(raw)) return false;
  const split = raw.indexOf('&signature=');
  if (split < 1 || !/^signature=[A-Za-z0-9%_+/=.-]{16,1024}&key_id=\d{1,30}$/.test(raw.slice(split + 1))) return false;
  const values = new URLSearchParams(raw.slice(0, split));
  const custom = customData(values.get('custom_data'));
  return !!(custom && typeof custom.nonce === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(custom.nonce) &&
    values.get('transaction_id') && values.get('transaction_id').length <= 256);
}
function createInbox({ directory, verifyCallback, recordReward, logger = {}, now = Date.now,
    intervalMs = 2000, maxPending = 20000, maxBytes = 256 * 1024 * 1024,
    retentionMs = 7 * 86400000, maxTerminal = 50000, batchSize = 10,
    identity = processIdentity, syncFolder = null,
    alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } } }) {
  if (!path.isAbsolute(directory)) throw error('SSV_INBOX_PATH_INVALID');
  const root = path.resolve(directory), pending = path.join(root, 'pending'), done = path.join(root, 'receipts');
  let initialized, timer, running = false, scanningAt = 0, cleanupAt = 0;
  const due = new Map();
  async function syncDirectory(folder) {
    if (syncFolder) return syncFolder(folder);
    if (process.platform === 'win32') return;
    const handle = await fs.open(folder, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function initialize() {
    if (!initialized) initialized = (async () => {
      for (const folder of [root, pending, done, path.join(root, 'locks')]) {
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(folder) !== folder ||
            process.platform !== 'win32' && (stat.mode & 0o077)) throw error('SSV_INBOX_NOT_PRIVATE');
      }
      await syncDirectory(root); await syncDirectory(path.dirname(root));
    })().catch(err => { initialized = null; throw err; });
    return initialized;
  }
  async function read(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw error('SSV_INBOX_FILE_INVALID');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  async function exists(file) { try { await fs.lstat(file); return true; } catch (err) { if (missing(err)) return false; throw err; } }
  async function atomic(file, value) {
    const temporary = file + '.tmp-' + crypto.randomBytes(12).toString('hex');
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file); await syncDirectory(path.dirname(file));
    }
    finally { await fs.unlink(temporary).catch(err => { if (!missing(err)) throw err; }); }
  }
  async function lock(name) {
    const file = path.join(root, 'locks', name + '.lock');
    const token = crypto.randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Never expose an empty/partial owner after a crash between open and
        // write. link() claims the final name exclusively with complete,
        // already-fsynced contents, without overwriting another owner.
        const temporary = file + '.owner-' + token;
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, identity: await identity(process.pid), token, at: now() })); await handle.sync(); }
          finally { await handle.close(); }
          await fs.link(temporary, file);
        } finally { await fs.unlink(temporary).catch(failure => { if (!missing(failure)) throw failure; }); }
        return async () => { try { if ((await read(file)).token === token) await fs.unlink(file); } catch (err) { if (!missing(err)) throw err; } };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let owner;
        try { owner = await read(file); }
        catch (failure) {
          // A creator can be between open and fsync. Never steal a fresh lock.
          const stat = await fs.lstat(file).catch(() => null);
          if (stat && now() - stat.mtimeMs > 300000) await fs.unlink(file).catch(() => {});
          return null;
        }
        const currentIdentity = Number.isInteger(owner.pid) ? await identity(owner.pid) : null;
        const sameProcess = Number.isInteger(owner.pid) && alive(owner.pid) &&
          !(owner.identity && currentIdentity && owner.identity !== currentIdentity);
        const leaseMs = name === 'admission' ? 30000 : 300000;
        if (sameProcess && Number.isFinite(owner.at) && now() - owner.at >= 0 && now() - owner.at < leaseMs) return null;
        await fs.unlink(file).catch(failure => { if (!missing(failure)) throw failure; });
      }
    }
    return null;
  }
  async function receive(rawQuery) {
    if (!acceptable(rawQuery)) return { accepted: false, reason: 'malformed_callback' };
    await initialize();
    const id = crypto.createHash('sha256').update(rawQuery).digest('hex');
    const file = path.join(pending, id + '.json');
    async function cached() {
      for (const folder of [done, pending]) if (await exists(path.join(folder, id + '.json'))) {
        // Another request/worker may have renamed the fsynced file but not yet
        // synced its directory. A duplicate ACK must wait for durability too.
        await syncDirectory(folder); return true;
      }
      return false;
    }
    if (await cached()) return { accepted: true, cached: true };
    // A short bounded wait prevents a burst of legitimate callbacks from all
    // receiving 503 merely because another receipt is doing its fsync.
    let release;
    for (let attempt = 0; attempt < 100 && !release; attempt++) {
      release = await lock('admission');
      if (!release) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!release) throw error('SSV_INBOX_BUSY');
    try {
      if (await cached()) return { accepted: true, cached: true };
      const names = (await fs.readdir(pending)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (names.length >= maxPending) throw error('SSV_INBOX_CAPACITY');
      // Reserve the maximum including durable verification evidence, not just
      // the smaller initial callback, so a DB outage cannot exhaust the disk.
      if ((names.length + 1) * 65536 > maxBytes) throw error('SSV_INBOX_CAPACITY');
      const instant = now();
      await atomic(file, { id, rawQuery, firstReceivedAt: instant, attempts: 0, nextAttemptAt: instant });
      due.set(id, instant);
      return { accepted: true, cached: false };
    } finally { await release(); }
  }
  async function processOne(id) {
    if (!ID.test(id)) return;
    const release = await lock(id);
    if (!release) return;
    const file = path.join(pending, id + '.json');
    try {
      if (await exists(path.join(done, id + '.json'))) { await fs.unlink(file).catch(err => { if (!missing(err)) throw err; }); due.delete(id); return; }
      let item = await read(file);
      if (item.id !== id || crypto.createHash('sha256').update(item.rawQuery || '').digest('hex') !== id || !acceptable(item.rawQuery))
        throw error('SSV_INBOX_RECORD_CORRUPT');
      if (item.nextAttemptAt > now()) { due.set(id, item.nextAttemptAt); return; }
      try {
        const result = item.verifiedParams ? { valid: true, params: item.verifiedParams } : await verifyCallback(item.rawQuery);
        if (result.retryable) throw error('SSV_VERIFIER_UNAVAILABLE');
        let status = 'rejected', reason = result.reason || 'invalid_signature';
        if (result.valid) {
          if (!item.verifiedParams) {
            // Save the verified facts before touching Mongo. Later retries do
            // not depend on Google retaining an old rotating verification key.
            item = { ...item, verifiedParams: result.params, verifiedAt: now() };
            if (Buffer.byteLength(JSON.stringify(item)) > 65536) throw error('SSV_VERIFIED_RECORD_TOO_LARGE');
            await atomic(file, item);
          }
          const p = result.params, custom = customData(p.customData);
          if (!custom?.nonce || !p.transactionId) { reason = 'missing_verified_identity'; }
          else {
            const reward = await recordReward({ nonce: String(custom.nonce), userId: p.userId || custom.userId || null,
              transactionId: p.transactionId, adUnitId: p.adUnit, adNetwork: p.adNetwork,
              rewardAmount: p.rewardAmount, rewardItem: p.rewardItem, timestampMs: p.timestamp });
            status = reward.found ? 'verified' : 'ignored';
            reason = reward.alreadyProcessed ? 'already_processed' : reward.found ? 'reward_recorded' : 'nonce_not_found_or_user_mismatch';
          }
        }
        await atomic(path.join(done, id + '.json'), { id, status, reason,
          attempts: item.attempts + 1, firstReceivedAt: item.firstReceivedAt, completedAt: now() });
        await fs.unlink(file); await syncDirectory(pending); due.delete(id);
      } catch (err) {
        const attempts = item.attempts + 1;
        const nextAttemptAt = now() + Math.min(30 * 60000, 5000 * 2 ** Math.min(attempts - 1, 9));
        await atomic(file, { ...item, attempts, nextAttemptAt }); due.set(id, nextAttemptAt);
        if (attempts === 1 || attempts % 10 === 0) logger.warn?.('[ADMOB SSV] Durable reward pending', { attempts, nextAttemptAt, code: 'dependency_or_processing_unavailable' });
      }
    } catch (err) {
      if (missing(err)) due.delete(id);
      else logger.error?.('[ADMOB SSV] Inbox item requires attention', { code: err.code || 'inbox_io_or_record_error' });
    } finally { await release(); }
  }
  async function scan() {
    const names = await fs.readdir(pending);
    for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const id = name.slice(0, -5);
      if (!due.has(id)) {
        try { due.set(id, (await read(path.join(pending, name))).nextAttemptAt || 0); }
        catch (_) { logger.error?.('[ADMOB SSV] Unreadable pending receipt', { code: 'inbox_record_unreadable' }); }
      }
    }
    scanningAt = now();
  }
  async function cleanup() {
    const names = (await fs.readdir(done)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const rows = [];
    for (const name of names) { const stat = await fs.stat(path.join(done, name)); rows.push({ name, at: stat.mtimeMs }); }
    rows.sort((a, b) => a.at - b.at);
    for (let i = 0; i < rows.length; i++) if (rows[i].at < now() - retentionMs || i < rows.length - maxTerminal)
      await fs.unlink(path.join(done, rows[i].name)).catch(err => { if (!missing(err)) throw err; });
    // Temporary files can remain after a hard kill before rename. They are not
    // accepted callbacks and may only be removed when safely older than a day.
    for (const folder of [pending, done, path.join(root, 'locks')]) for (const name of await fs.readdir(folder))
      if ((/^[a-f0-9]{64}\.json\.tmp-[a-f0-9]{24}$/.test(name) || /^(?:admission|[a-f0-9]{64})\.lock\.owner-[a-f0-9]{32}$/.test(name)) &&
          (await fs.stat(path.join(folder, name))).mtimeMs < now() - 86400000)
        await fs.unlink(path.join(folder, name)).catch(() => {});
    cleanupAt = now();
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      await initialize();
      if (!scanningAt || now() - scanningAt >= 30000) await scan();
      const ready = [...due].filter(([, at]) => at <= now()).sort((a, b) => a[1] - b[1]).slice(0, batchSize);
      for (let i = 0; i < ready.length; i += 2) await Promise.all(ready.slice(i, i + 2).map(([id]) => processOne(id)));
      if (!cleanupAt || now() - cleanupAt >= 3600000) await cleanup();
    } catch (err) { logger.error?.('[ADMOB SSV] Inbox recovery unavailable', { code: err.code || 'inbox_recovery_error' }); }
    finally { running = false; }
  }
  async function start() {
    await initialize();
    if (!timer) { timer = setInterval(() => void drain(), intervalMs); timer.unref(); }
    void drain();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { receive, drain, start, stop };
}
module.exports = { createInbox, acceptable, customData };
