'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const readSync = require('node:fs').readFileSync;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createInbox } = require('../src/core/rewardedSsvInbox');
const { createRecovery } = require('../src/api/services/common/rewardedWheelRecovery');
const logger = { info() {}, warn() {}, error() {} };
const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = key.publicKey.export({ type: 'spki', format: 'pem' });
const nonce = 'idx0-' + 'a'.repeat(40);
function query(transaction = 'transaction-1', extra = '') {
  const signed = 'ad_network=network&ad_unit=unit&custom_data=' + encodeURIComponent(JSON.stringify({ nonce })) +
    '&reward_amount=1&reward_item=Reward&timestamp=1600000000000&transaction_id=' + transaction + extra;
  return signed + '&signature=' + crypto.sign('sha256', Buffer.from(signed), key.privateKey).toString('base64url') + '&key_id=42';
}
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(readSync(path.join(__dirname, '..', file), 'utf8'), { module, exports: module.exports,
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; if (name.startsWith('node:') || name === 'crypto') return require(name); throw Error('Unmocked ' + name); },
    process: { env: {} }, Buffer, URLSearchParams, Date, Map }, { filename: file });
  return module.exports;
}
function verifier(online = () => true) {
  return load('src/api/services/common/admobSsvService.js', { axios: { async get() {
    if (!online()) throw Error('temporary key outage');
    return { data: { keys: [{ keyId: 42, pem }] } };
  } }, '../../../utils/logger': logger });
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssv-recovery-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('ssv-recovery-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function receipts(directory) {
  return Promise.all((await fs.readdir(path.join(directory, 'receipts'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(async name => JSON.parse(await fs.readFile(path.join(directory, 'receipts', name)))));
}

test('real ECDSA verifier distinguishes transient key-server failure from an unknown key and invalid signature', async () => {
  let online = false;
  const svc = verifier(() => online);
  await assert.rejects(svc.verifyCallback(query()), err => err.code === 'ADMOB_VERIFIER_UNAVAILABLE');
  online = true;
  assert.equal((await svc.verifyCallback(query())).valid, true);
  assert.equal((await svc.verifyCallback(query().replace('ad_unit=unit', 'ad_unit=changed'))).valid, false);
  assert.equal((await svc.verifyCallback(query().replace('key_id=42', 'key_id=999'))).reason, 'unknown_key_id');
});

test('callback survives key outage, process restart and Mongo outage, preserving first receipt and provider timestamp', async t => {
  const directory = await temporary(t); let instant = Date.now(), keysOnline = false, dbOnline = false, grants = 0, verificationCalls = 0;
  const transactions = new Set(), svc = verifier(() => keysOnline);
  const options = { directory, now: () => instant, verifyCallback: raw => { verificationCalls++; return svc.verifyCallback(raw); }, logger,
    async recordReward(reward) {
      if (!dbOnline) throw Error('database temporarily unavailable');
      assert.equal(reward.timestampMs, '1600000000000');
      const alreadyProcessed = transactions.has(reward.transactionId);
      if (!alreadyProcessed) { transactions.add(reward.transactionId); grants++; }
      return { found: true, alreadyProcessed };
    } };
  let inbox = createInbox(options); const originalQuery = query();
  assert.equal((await inbox.receive(originalQuery)).accepted, true);
  await inbox.drain();
  let names = await fs.readdir(path.join(directory, 'pending'));
  const original = JSON.parse(await fs.readFile(path.join(directory, 'pending', names[0])));
  assert.equal(original.attempts, 1); assert.equal(grants, 0);
  keysOnline = true; instant += 5000; inbox = createInbox(options); await inbox.drain();
  assert.equal(grants, 0);
  const callsBeforeRecovery = verificationCalls;
  dbOnline = true; instant += 10000; inbox = createInbox(options); await inbox.drain();
  assert.equal(verificationCalls, callsBeforeRecovery, 'saved verification survives key rotation/outage while Mongo is down');
  assert.equal(grants, 1); assert.equal((await receipts(directory))[0].firstReceivedAt, original.firstReceivedAt);
  assert.equal((await receipts(directory))[0].status, 'verified');
  assert.equal((await inbox.receive(originalQuery)).cached, true); await inbox.drain(); assert.equal(grants, 1);
  // Different valid signed bytes carrying the same transaction remain exactly once.
  await inbox.receive(query('transaction-1', '&reward_custom=another-signed-encoding')); await inbox.drain();
  assert.equal(grants, 1); assert.equal((await receipts(directory)).length, 2);
});

test('ambiguous DB commit is retried after restart without granting a second reward', async t => {
  const directory = await temporary(t); let instant = Date.now(), credited = false, attempts = 0, grants = 0;
  const svc = verifier(); const options = { directory, now: () => instant, verifyCallback: svc.verifyCallback, logger,
    async recordReward() {
      attempts++;
      if (!credited) { credited = true; grants++; throw Error('connection lost after atomic commit'); }
      return { found: true, alreadyProcessed: true };
    } };
  let inbox = createInbox(options); await inbox.receive(query()); await inbox.drain();
  instant += 5000; inbox = createInbox(options); await inbox.drain();
  assert.equal(grants, 1); assert.equal(attempts, 2); assert.equal((await receipts(directory))[0].status, 'verified');
});

test('invalid signed callback is durably rejected and never credited', async t => {
  const directory = await temporary(t); let grants = 0; const svc = verifier();
  const inbox = createInbox({ directory, verifyCallback: svc.verifyCallback, async recordReward() { grants++; }, logger });
  await inbox.receive(query().replace('ad_unit=unit', 'ad_unit=forged')); await inbox.drain();
  assert.equal(grants, 0); assert.equal((await receipts(directory))[0].status, 'rejected');
});

test('pending quota rejects new acceptance without deleting previously accepted callbacks', async t => {
  const directory = await temporary(t);
  const inbox = createInbox({ directory, maxPending: 1, verifyCallback: async () => { throw Error('outage'); }, recordReward: async () => {}, logger });
  assert.equal((await inbox.receive(query('first'))).accepted, true);
  await assert.rejects(inbox.receive(query('second')), err => err.code === 'SSV_INBOX_CAPACITY');
  await inbox.drain(); assert.equal((await fs.readdir(path.join(directory, 'pending'))).length, 1);
  assert.equal((await inbox.receive('not-a-signed-callback')).accepted, false);
});

test('autonomous startup drains an existing durable callback without a new HTTP request', async t => {
  const directory = await temporary(t); let grants = 0; const svc = verifier();
  const options = { directory, intervalMs: 5, verifyCallback: svc.verifyCallback, recordReward: async () => { grants++; return { found: true }; }, logger };
  await createInbox(options).receive(query());
  const restarted = createInbox(options); t.after(() => restarted.stop()); await restarted.start();
  for (let i = 0; i < 100 && !(await receipts(directory)).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(grants, 1); assert.equal((await receipts(directory))[0].status, 'verified');
});

test('HTTP acknowledges only durable admission; unavailable spool returns 503', async () => {
  for (const broken of [false, true]) {
    let status;
    const ctrl = load('src/api/controllers/common/admobSsvController.js', {
      '../../services/common/admobSsvInboxService': { async receive() { if (broken) throw Object.assign(Error('disk unavailable'), { code: 'ENOSPC' }); return { accepted: true }; } },
      '../../services/common/accessGateService': {}, '../../../utils/logger': logger,
    });
    await ctrl.handleRewardedSsv({ originalUrl: '/api/ads/admob/ssv?' + query(), log: logger }, { status(value) { status = value; return this; }, send() { return this; } });
    assert.equal(status, broken ? 503 : 200);
  }
});

test('a concurrent admission burst durably keeps one copy without rejecting ordinary duplicate retries', async t => {
  const directory = await temporary(t), svc = verifier(); let grants = 0;
  const inbox = createInbox({ directory, verifyCallback: svc.verifyCallback, recordReward: async () => { grants++; return { found: true }; }, logger });
  const raw = query(), results = await Promise.all(Array.from({ length: 12 }, () => inbox.receive(raw)));
  assert.ok(results.every(result => result.accepted));
  assert.equal((await fs.readdir(path.join(directory, 'pending'))).filter(name => name.endsWith('.json')).length, 1);
  await inbox.drain(); assert.equal(grants, 1);
});

test('an orphan process claim is recovered after restart', async t => {
  const directory = await temporary(t), svc = verifier(); let grants = 0;
  const inbox = createInbox({ directory, alive: pid => pid === process.pid, verifyCallback: svc.verifyCallback,
    recordReward: async () => { grants++; return { found: true }; }, logger });
  const raw = query(), id = crypto.createHash('sha256').update(raw).digest('hex');
  await inbox.receive(raw);
  await fs.writeFile(path.join(directory, 'locks', id + '.lock'), JSON.stringify({ pid: 99999999, token: 'dead-owner', at: Date.now() }), { mode: 0o600 });
  await inbox.drain(); assert.equal(grants, 1); assert.equal((await receipts(directory))[0].status, 'verified');
});

test('a duplicate ACK waits for directory durability even after the original rename is visible', async t => {
  const directory = await temporary(t); let releaseSync, secondAccepted = false;
  const barrier = new Promise(resolve => { releaseSync = resolve; });
  const inbox = createInbox({ directory, verifyCallback: async () => ({ valid: false }), recordReward: async () => {}, logger,
    async syncFolder(folder) { if (folder === path.join(directory, 'pending')) await barrier; } });
  const raw = query(), first = inbox.receive(raw);
  for (let i = 0; i < 100; i++) {
    const names = await fs.readdir(path.join(directory, 'pending')).catch(() => []);
    if (names.some(name => /^[a-f0-9]{64}\.json$/.test(name))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const second = inbox.receive(raw).then(result => { secondAccepted = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(secondAccepted, false);
  releaseSync(); assert.ok((await Promise.all([first, second])).every(row => row.accepted));
});

test('reused PID from an earlier boot and an expired admission lease cannot block reception indefinitely', async t => {
  for (const old of [{ identity: 'earlier-boot:old-process', at: Date.now() }, { identity: 'current-boot:current-process', at: Date.now() - 60000 }]) {
    const directory = await temporary(t);
    const inbox = createInbox({ directory, identity: async () => 'current-boot:current-process', alive: () => true,
      verifyCallback: async () => ({ valid: false }), recordReward: async () => {}, logger });
    await inbox.receive(query('setup'));
    await fs.writeFile(path.join(directory, 'locks/admission.lock'), JSON.stringify({ pid: process.pid, token: 'old-owner', ...old }), { mode: 0o600 });
    assert.equal((await inbox.receive(query('after-restart'))).accepted, true);
  }
});

test('a crash before atomic lock claim exposes no partial owner and a new request recovers immediately', async t => {
  const directory = await temporary(t), originalLink = fs.link; let interrupted = false;
  const inbox = createInbox({ directory, verifyCallback: async () => ({ valid: false }), recordReward: async () => {}, logger });
  fs.link = async (source, target) => {
    if (!interrupted && target.endsWith('admission.lock')) {
      const owner = JSON.parse(await fs.readFile(source, 'utf8'));
      assert.equal(owner.pid, process.pid); assert.match(owner.token, /^[a-f0-9]{32}$/);
      interrupted = true; throw Error('synthetic crash before exclusive claim');
    }
    return originalLink.call(fs, source, target);
  };
  try {
    await assert.rejects(inbox.receive(query()), /synthetic crash/);
    assert.equal((await fs.readdir(path.join(directory, 'locks'))).includes('admission.lock'), false);
  } finally { fs.link = originalLink; }
  assert.equal((await inbox.receive(query())).accepted, true);
});

test('cleanup prunes terminal evidence only; an old accepted pending callback remains recoverable', async t => {
  const directory = await temporary(t); let instant = Date.now(); const svc = verifier();
  const inbox = createInbox({ directory, now: () => instant, retentionMs: 1, verifyCallback: svc.verifyCallback,
    async recordReward(reward) { if (reward.transactionId === 'pending') throw Error('long DB outage'); return { found: true }; }, logger });
  await inbox.receive(query('pending')); await inbox.receive(query('completed')); await inbox.drain();
  assert.equal((await receipts(directory)).length, 1);
  instant += 30 * 86400000; await inbox.drain();
  assert.equal((await receipts(directory)).length, 0);
  const names = (await fs.readdir(path.join(directory, 'pending'))).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  const retained = JSON.parse(await fs.readFile(path.join(directory, 'pending', names[0])));
  assert.equal(retained.firstReceivedAt, instant - 30 * 86400000); assert.ok(retained.verifiedParams);
});

function wheelFixture(multiTenant) {
  const pack = { tickets: 5, adsRequired: 2, label: { fr: '5 tours' } }, cfg = { _id: 'config', wheelEnabled: true, ticketPacks: [pack, { tickets: 9, adsRequired: 3 }] };
  let doc = { _id: 'unlock', nonce, status: 'unlocked', selectedOption: { adsRequired: 2, ticketsToCredit: 5 }, verifiedCount: 2 };
  const stats = { ticketsBalance: 0, totalTicketsEarned: 0, rewardedCredits: [] }; let increments = 0, crashReset = false;
  const clone = value => value == null ? value : structuredClone(value);
  const Query = value => ({ async select() { return clone(value); }, then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); } });
  const Unlock = {
    async findOne() { return clone(doc); },
    async updateOne(filter, update) {
      if (crashReset) { crashReset = false; throw Error('crash after credit before session reset'); }
      if (doc.nonce === filter.nonce && doc.status === filter.status) Object.assign(doc, clone(update.$set));
    },
    async findOneAndUpdate(filter, update) { if (doc.nonce !== filter.nonce) return null; Object.assign(doc, clone(update.$set)); return clone(doc); },
    async create(value) { doc = { _id: 'unlock', ...clone(value) }; return clone(doc); },
  };
  const Stats = { async getOrCreate() { return clone(stats); }, findOne() { return Query(stats); },
    async findOneAndUpdate(filter, update) {
      assert.equal(filter['rewardedCredits.nonce'].$ne, nonce);
      if (stats.rewardedCredits.some(row => row.nonce === nonce)) return null;
      // One synchronous atomic section, matching Mongo's single-document update.
      stats.ticketsBalance += update.$inc.ticketsBalance; stats.totalTicketsEarned += update.$inc.totalTicketsEarned;
      stats.rewardedCredits.push(clone(update.$push.rewardedCredits)); Object.assign(stats, update.$set); increments++;
      return clone(stats);
    } };
  class AppError extends Error { constructor(message, status) { super(message); this.statusCode = status; } }
  const dependencies = { UserAccessUnlock: Unlock, WheelUserStats: Stats, WheelConfig: { async getSingleton() { return cfg; } },
    AppError, ErrorCodes: {}, multiTenant };
  const api = createRecovery(dependencies), args = multiTenant ? ['bigwin', 'user'] : ['user'];
  return { api, args, stats, get doc() { return doc; }, set doc(value) { doc = value; }, increments: () => increments,
    restart: () => createRecovery(dependencies), crashNextReset: () => { crashReset = true; } };
}
for (const multiTenant of [false, true]) {
  const name = multiTenant ? 'BigWin multi-tenant' : 'WinTips';
  test(name + ': concurrent polls credit once and replay remains acknowledged after reset', async () => {
    const h = wheelFixture(multiTenant);
    const results = await Promise.all(Array.from({ length: 12 }, () => h.api.getUnlockState(...h.args, nonce)));
    assert.equal(h.stats.ticketsBalance, 5); assert.equal(h.stats.totalTicketsEarned, 5); assert.equal(h.increments(), 1);
    assert.ok(results.every(row => row.completed && row.creditedNonce === nonce));
    const replay = await h.restart().getUnlockState(...h.args, nonce);
    assert.equal(replay.completed, true); assert.equal(replay.justCredited, 0); assert.equal(replay.creditedTickets, 5);
  });
  test(name + ': crash after balance commit recovers reset without another credit', async () => {
    const h = wheelFixture(multiTenant); h.crashNextReset();
    await assert.rejects(h.api.getUnlockState(...h.args, nonce), /crash after credit/);
    assert.equal(h.stats.ticketsBalance, 5); assert.equal(h.doc.nonce, nonce);
    const result = await h.restart().getUnlockState(...h.args, nonce);
    assert.equal(result.completed, true); assert.equal(result.justCredited, 0); assert.equal(h.doc.nonce, null);
    assert.equal(h.increments(), 1);
  });
  test(name + ': reopening pending same pack preserves signed nonce, verified progress and reward history', async () => {
    const h = wheelFixture(multiTenant); h.doc.status = 'in_progress'; h.doc.verifiedCount = 1; h.doc.rewards = [{ transactionId: 'first' }];
    const before = structuredClone(h.doc);
    const resumed = await h.api.startUnlock(...h.args, 0);
    assert.equal(resumed.nonce, nonce); assert.equal(resumed.adsWatched, 1); assert.equal(resumed.verifiedCount, 1); assert.equal(resumed.resumed, true);
    assert.deepEqual(h.doc, before);
    await assert.rejects(h.api.startUnlock(...h.args, 1), err => err.statusCode === 409);
    assert.deepEqual(h.doc, before);
  });
}

test('the existing atomic reward service counts concurrent callback replay once and rejects a mismatched nonce/user', async () => {
  class ObjectId { constructor(value) { this.value = String(value); } equals(other) { return this.value === String(other?.value || other); } }
  const doc = { nonce: 'b'.repeat(48), user: new ObjectId('owner'), status: 'in_progress', verifiedCount: 0,
    rewards: [], isAccessActive() { return this.status === 'unlocked'; } };
  const Unlock = { async findOneAndUpdate(filter, stages) {
    if (filter.nonce !== doc.nonce || filter.user && !doc.user.equals(filter.user) || doc.status !== 'in_progress' ||
        doc.rewards.some(row => row.transactionId === filter['rewards.transactionId'].$ne)) return null;
    const reward = stages[0].$set.rewards.$concatArrays[1][0]; doc.rewards.push(reward); doc.verifiedCount++;
    return doc;
  }, async findOne(filter) { return filter.nonce === doc.nonce ? doc : null; }, async updateOne() {} };
  const svc = load('src/api/services/common/accessGateService.js', { mongoose: { Types: { ObjectId } },
    '../../models/common/UserAccessUnlock': Unlock, '../../../utils/AppError': { AppError: Error, ErrorCodes: {} } });
  const reward = { nonce: doc.nonce, userId: 'owner', transactionId: 'provider-once', rewardAmount: '1', timestampMs: '1600000000000' };
  const results = await Promise.all(Array.from({ length: 12 }, () => svc.recordVerifiedReward(reward)));
  assert.equal(doc.verifiedCount, 1); assert.equal(doc.rewards.length, 1);
  assert.ok(results.every(result => result.found));
  assert.equal((await svc.recordVerifiedReward({ ...reward, transactionId: 'other', userId: 'different' })).found, false);
  assert.equal((await svc.recordVerifiedReward({ ...reward, nonce: 'unknown' })).found, false);
  assert.equal(doc.verifiedCount, 1);
});

test('same category offer resumes the exact nonce without saving over a concurrent reward', async () => {
  const doc = { nonce: 'c'.repeat(48), status: 'in_progress', verifiedCount: 1,
    selectedOption: { adsRequired: 2, durationMinutes: 30 }, isAccessActive() { return false; },
    async save() { throw Error('resumption must not write a stale document'); } };
  const svc = load('src/api/services/common/accessGateService.js', { mongoose: {},
    '../../models/common/UserAccessUnlock': { async findOne() { return doc; } },
    '../../../utils/AppError': { AppError: Error, ErrorCodes: {} } });
  const category = { _id: 'category', accessGate: { type: 'ad_reward', options: [{ adsRequired: 2, durationMinutes: 30 }] } };
  const multi = readSync(path.join(__dirname, '../src/api/services/common/accessGateService.js'), 'utf8').includes('startOrSwitchUnlock(appId,');
  const result = await svc.startOrSwitchUnlock(...(multi ? ['bigwin', 'user', category, 30] : ['user', category, 30]));
  assert.equal(result.nonce, doc.nonce); assert.equal(result.verifiedCount, 1); assert.equal(result.adsWatched, 1); assert.equal(result.resumed, true);
});

if (require('node:fs').existsSync(path.join(__dirname, '../src/api/services/user/packageAdUnlockService.js'))) {
  test('WinTips package reopening retains the pending signed nonce and verified count', async () => {
    const doc = { nonce: 'd'.repeat(48), status: 'in_progress', verifiedCount: 1, selectedOption: { adsRequired: 3 },
      async save() { throw Error('must not reset a pending package'); } };
    const pkg = { _id: 'package', isActive: true, paymentMode: 'ads', adsRequired: 3 };
    const service = load('src/api/services/user/packageAdUnlockService.js', {
      '../../models/common/UserAccessUnlock': { async findOne() { return doc; } },
      '../../models/common/Package': { async findById() { return pkg; } },
      '../../models/common/Subscription': { findOne() { return { async lean() { return null; } }; } },
      './subscriptionService': {}, '../../../utils/AppError': { AppError: Error, ErrorCodes: {} },
    });
    const result = await service.start('user', 'package');
    assert.equal(result.nonce, doc.nonce); assert.equal(result.adsWatched, 1); assert.equal(result.verifiedCount, 1); assert.equal(result.resumed, true);
  });
}
