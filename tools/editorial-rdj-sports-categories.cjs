#!/usr/bin/env node
'use strict';
// NBA publisher migration and optional tennis activation, dry-run by default. No source imports.
const fs = require('node:fs');
const path = require('node:path');
const { readState, applyPlan, parseArgs } = require('./editorial-catalogue.cjs');
const { createRdjSportsCategoryPlan: createNbaCategoryPlan, verifyRdjSportsCategoryPlan: verifyNbaCategoryPlan } = require('../src/api/services/common/editorialRdjSportsCategories');

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'rollback' || argv.includes('--config')) throw Object.assign(new Error(), { code: 'NBA_ARGUMENTS' });
  let fd, connection;
  try {
    if (options.out) {
      fd = fs.openSync(options.out, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ status: 'pending', mode: options.mode }) + '\n'); fs.fsyncSync(fd);
    }
    if (!process.env.WINTIPS_CATALOGUE_MONGO_URI) throw Object.assign(new Error(), { code: 'DATABASE_REQUIRED' });
    const mongoose = require('mongoose');
    connection = await mongoose.createConnection(process.env.WINTIPS_CATALOGUE_MONGO_URI,
      { autoCreate: false, autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 }).asPromise();
    let result;
    if (options.mode === 'plan') result = createNbaCategoryPlan(await readState(connection.db));
    else {
      const plan = JSON.parse(fs.readFileSync(options.planFile, 'utf8'));
      verifyNbaCategoryPlan(plan, options.confirmHash);
      result = await applyPlan(connection.db, connection.getClient(), plan, options);
    }
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (fd !== undefined) {
      fs.ftruncateSync(fd, 0); fs.writeSync(fd, serialized, 0, 'utf8'); fs.fsyncSync(fd);
      console.log(JSON.stringify({ mode: options.mode, output: path.resolve(options.out), planHash: result.planHash,
        receiptHash: result.receiptHash, applied: result.applied, notificationsSent: false }));
    } else console.log(serialized);
  } finally { if (connection) await connection.close(); if (fd !== undefined) fs.closeSync(fd); }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ success: false, code: String(error.code || error.name || 'ERROR') })); process.exitCode = 1;
});
module.exports = { main };
