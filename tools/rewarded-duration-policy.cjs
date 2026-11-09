#!/usr/bin/env node
'use strict';
// Maintenance only. Does not load the API, jobs, users, subscriptions or SSV.
const fs = require('node:fs');
const policy = require('../src/api/services/common/rewardedDurationPolicy');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function parseArgs(argv) {
  const options = { mode: 'plan' }, modes = [];
  const values = { '--scope': 'scope', '--out': 'out', '--plan-file': 'planFile', '--confirm-sha256': 'confirmHash' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--plan', '--apply', '--rollback'].includes(arg)) { options.mode = arg.slice(2); modes.push(arg); }
    else if (arg === '--confirm-category-offer-mutation') options.intent = true;
    else if (values[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) options[values[arg]] = argv[++index];
    else fail('DURATION_ARGUMENTS');
  }
  if (modes.length > 1 || !Object.hasOwn(policy.DATABASES, options.scope) || !options.out ||
      options.mode !== 'plan' && (!options.intent || !options.planFile || !options.confirmHash)) fail('DURATION_ARGUMENTS');
  return options;
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!process.env.REWARDED_DURATION_MONGO_URI) fail('DURATION_DATABASE_REQUIRED');
  const mongoose = require('mongoose'), connection = await mongoose.createConnection(process.env.REWARDED_DURATION_MONGO_URI,
    { autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000 }).asPromise();
  let fd;
  try {
    const db = connection.db;
    if (db.databaseName !== policy.DATABASES[options.scope]) fail('DURATION_DATABASE_MISMATCH');
    fd = fs.openSync(options.out, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ status: 'pending', mode: options.mode }) + '\n'); fs.fsyncSync(fd);
    let result;
    if (options.mode === 'plan') {
      const categories = await db.collection('categories').find({ 'accessGate.type': 'ad_reward' },
        { projection: { appId: 1, appIds: 1, isActive: 1, isVip: 1, editorialSource: 1, accessGate: 1 }, maxTimeMS: 5000 }).limit(1001).toArray();
      result = policy.createPlan({ scope: options.scope, databaseName: db.databaseName, categories });
    } else {
      const buffer = fs.readFileSync(options.planFile);
      if (buffer.length > 4 * 1024 * 1024) fail('DURATION_PLAN_TOO_LARGE');
      const plan = JSON.parse(buffer.toString('utf8'));
      if (plan.scope !== options.scope) fail('DURATION_PLAN_SCOPE_INVALID');
      result = await policy.applyPlan(db, connection.getClient(), plan, { confirmHash: options.confirmHash,
        objectId: value => new mongoose.Types.ObjectId(value), mode: options.mode });
    }
    fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(result, null, 2) + '\n', 0, 'utf8'); fs.fsyncSync(fd);
    console.log(JSON.stringify({ status: 'completed', mode: options.mode, scope: options.scope,
      planHash: result.planHash, operations: result.operations?.length, changed: result.changed,
      skipped: result.skipped, output: options.out, notificationsSent: false }));
    return result;
  } finally { if (fd !== undefined) fs.closeSync(fd); await connection.close(); }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', code: String(error.code || error.name || 'ERROR') })); process.exitCode = 1;
});
module.exports = { parseArgs, main };
