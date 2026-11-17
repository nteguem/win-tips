'use strict';
// Pure import preflight. No API/bootstrap, database, credentials or provider.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const root = path.resolve(__dirname, '../..');
let validation, equivalentNumericFacts;
function dependencies() {
  if (!validation) {
    validation = require(path.join(root, 'src/api/services/common/editorialValidation'));
    ({ equivalentNumericFacts } = require(path.join(root, 'src/api/services/common/editorialNumericFacts')));
  }
}
const VERSION = 'editorial-api-preflight-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function diagnostics(item, prefix = '') {
  dependencies();
  const rows = [], add = (field, fr, en) => {
    if (typeof en !== 'string' || !en.trim() || !equivalentNumericFacts(fr, en))
      rows.push({ sourceId: item.sourceId, field: prefix + field, code: 'english_field_missing_or_numeric_mismatch' });
  };
  for (const field of ['title', 'summary']) add(field, item[field]?.fr, item[field]?.en);
  add('selection.label', item.selection?.label?.fr, item.selection?.label?.en);
  const fr = item.analysis?.fr || [], en = item.analysis?.en || [];
  if (fr.length !== en.length) rows.push({ sourceId: item.sourceId, field: prefix + 'analysis', code: 'english_structure_mismatch' });
  fr.forEach((section, index) => {
    add(`analysis[${index}].heading`, section.heading, en[index]?.heading);
    if (section.paragraphs.length !== en[index]?.paragraphs?.length)
      rows.push({ sourceId: item.sourceId, field: prefix + `analysis[${index}].paragraphs`, code: 'english_structure_mismatch' });
    section.paragraphs.forEach((paragraph, number) => add(`analysis[${index}].paragraphs[${number}]`, paragraph, en[index]?.paragraphs?.[number]));
  });
  for (let index = 0; index < (item.legs || []).length; index++) rows.push(...diagnostics(item.legs[index], prefix + `legs[${index}].`));
  return rows;
}

function validate(raw, now = new Date()) {
  dependencies();
  const report = { version: VERSION, passed: false, checkedAtUtc: now.toISOString(), payloadSha256: sha(raw), diagnostics: [] };
  let payload, batch;
  try {
    if (raw.length > 4000000) throw new Error();
    payload = JSON.parse(raw.toString('utf8'));
    batch = validation.validateBatch(payload, now);
  } catch (_) { return { ...report, code: 'api_payload_schema_or_clock_invalid', stage: 'validateBatch' }; }
  Object.assign(report, { source: batch.source, editionDate: batch.editionDate, itemCount: batch.items.length });
  // Preserve safe field-path diagnostics, but translation quality is advisory.
  // Match importBatch's source-language fallback before testing usability.
  report.diagnostics = batch.items.flatMap(item => diagnostics(item));
  validation.completeEnglishWithFallback(batch.items);
  try { validation.requireCompleteEnglish(batch.items); }
  catch (_) { return { ...report, code: 'api_complete_english_invalid', stage: 'requireCompleteEnglish', diagnostics: batch.items.flatMap(item => diagnostics(item)) }; }
  return { ...report, passed: true, code: 'validated', stage: 'ready_for_final_api_validation' };
}

function checkout() {
  const command = args => cp.execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
  if (fs.realpathSync(command(['rev-parse', '--show-toplevel']).toString().trim()) !== fs.realpathSync(root)) throw new Error();
  const head = command(['rev-parse', 'HEAD']).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error();
  const sources = ['tools/wintips-editorial-worker/validate-api-payload.cjs',
    'src/api/services/common/editorialValidation.js', 'src/api/services/common/editorialNumericFacts.js',
    'src/api/services/common/editorialSources.js', 'src/api/services/common/editorialCalendar.js',
    'src/api/services/common/petitJournalClockProof.js',
    'src/api/services/common/editorialCopy.js', 'src/api/services/common/couponTeaser.js'];
  const hashes = {};
  for (const relative of sources) {
    const file = path.join(root, relative);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error();
    const current = fs.readFileSync(file), committed = command(['show', head + ':' + relative]);
    if (!current.equals(committed)) throw new Error();
    hashes[relative] = sha(current);
  }
  if (command(['rev-parse', 'HEAD']).toString().trim() !== head) throw new Error();
  return { head, sourceSha256: hashes };
}

if (require.main === module) {
  let size = 0, chunks = [];
  process.stdin.on('data', chunk => {
    size += chunk.length;
    if (size > 4000000) { process.stdin.destroy(); console.log(JSON.stringify({ version: VERSION, passed: false, code: 'api_payload_too_large' })); process.exitCode = 1; }
    else chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    let report;
    try { const proof = checkout(); report = { ...validate(Buffer.concat(chunks)), checkout: proof }; }
    catch (_) { report = { version: VERSION, passed: false, code: 'api_validator_checkout_unavailable' }; }
    console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : 1;
  });
}
module.exports = { validate, checkout, diagnostics, VERSION };
