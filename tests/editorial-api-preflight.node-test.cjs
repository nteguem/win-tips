'use strict';
// Pure validation only: no checkout CLI, credentials, DB, provider or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validate, VERSION } = require('../tools/wintips-editorial-worker/validate-api-payload.cjs');

const DAY = '2026-10-24';
const now = () => new Date(`${DAY}T10:00:00Z`);
const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.from(JSON.stringify(value), 'utf8');
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
function payload() {
  return {
    source: 'rdj_petit_journal', editionDate: DAY,
    items: [{
      sourceId: '5795487',
      sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74782-le-petit-journal-du-parieur-samedi-24-octobre-2026.html',
      kind: 'match', title: { fr: 'Equipe A — Equipe B', en: 'Equipe A — Equipe B' },
      summary: { fr: 'Deux équipes en forme.', en: 'Two teams in form.' },
      startsAtUtc: `${DAY}T16:00:00Z`,
      sport: { key: 'football', name: 'Football' }, competition: { name: 'Coupe' },
      teams: { home: { name: 'Equipe A' }, away: { name: 'Equipe B' } },
      analysis: {
        fr: [{ heading: 'Forme récente', paragraphs: ['Equipe A compte 3 victoires en 5 matchs (2-1).'] }],
        en: [{ heading: 'Recent form', paragraphs: ['Equipe A has 3 wins in 5 matches (2-1).'] }],
      },
      selection: { label: { fr: 'Victoire Equipe A', en: 'Equipe A to win' }, odds: 1.66, betType: 'match_winner' },
      status: 'upcoming',
    }],
  };
}
function rejected(value, clock = now(), stage = 'validateBatch') {
  const raw = Buffer.isBuffer(value) ? value : bytes(value);
  const result = validate(raw, clock);
  assert.equal(result.passed, false);
  assert.equal(result.stage, stage);
  assert.equal(result.payloadSha256, sha(raw));
  return result;
}

test('API preflight validates a complete current bilingual match and hashes exact input bytes without mutation', () => {
  const original = payload(), snapshot = clone(original), raw = bytes(original), before = Buffer.from(raw);
  const result = validate(raw, now());
  assert.deepEqual(result, {
    version: VERSION, passed: true, checkedAtUtc: now().toISOString(), payloadSha256: sha(raw),
    diagnostics: [], source: 'rdj_petit_journal', editionDate: DAY, itemCount: 1,
    code: 'validated', stage: 'ready_for_final_api_validation',
  });
  assert.deepEqual(original, snapshot);
  assert.ok(raw.equals(before));
  assert.deepEqual(validate(raw, now()), result);
  assert.equal('payload' in result, false);
});

test('API preflight byte hashes distinguish whitespace-equivalent JSON inputs', () => {
  const compact = bytes(payload()), spaced = Buffer.from(JSON.stringify(payload(), null, 2), 'utf8');
  const first = validate(compact, now()), second = validate(spaced, now());
  assert.equal(first.passed, true); assert.equal(second.passed, true);
  assert.equal(first.payloadSha256, sha(compact)); assert.equal(second.payloadSha256, sha(spaced));
  assert.notEqual(first.payloadSha256, second.payloadSha256);
});

test('API preflight refuses missing English fields and returns only safe field paths', () => {
  for (const [field, remove] of [
    ['title', item => { delete item.title.en; }],
    ['summary', item => { delete item.summary.en; }],
    ['selection.label', item => { delete item.selection.label.en; }],
    ['analysis[0].heading', item => { delete item.analysis.en; }],
  ]) {
    const value = payload(); remove(value.items[0]);
    const result = rejected(value, now(), 'requireCompleteEnglish');
    assert.equal(result.code, 'api_complete_english_invalid');
    assert.ok(result.diagnostics.some(row => row.sourceId === '5795487' && row.field === field));
    for (const row of result.diagnostics) assert.deepEqual(Object.keys(row).sort(), ['code', 'field', 'sourceId']);
  }
});

test('API preflight rejects missing, changed and added quantities before POST without disclosing prose', () => {
  for (const target of [
    'CANDIDATE_TEXT_MUST_NOT_LEAK Equipe A has 4 wins in 5 matches (2-1).',
    'CANDIDATE_TEXT_MUST_NOT_LEAK Equipe A has wins in 5 matches (2-1).',
    'CANDIDATE_TEXT_MUST_NOT_LEAK Equipe A has 3 wins in 5 matches (2-1) and 7 titles.',
  ]) {
    const value = payload(); value.items[0].analysis.en[0].paragraphs[0] = target;
    const result = rejected(value, now(), 'requireCompleteEnglish');
    assert.deepEqual(result.diagnostics, [{ sourceId: '5795487', field: 'analysis[0].paragraphs[0]', code: 'english_field_missing_or_numeric_mismatch' }]);
    assert.equal(JSON.stringify(result).includes('CANDIDATE_TEXT_MUST_NOT_LEAK'), false);
    assert.equal(JSON.stringify(result).includes(value.items[0].sourceUrl), false);
  }
});

test('API preflight rejects incomplete English paragraph coverage with the exact missing path', () => {
  const value = payload(); value.items[0].analysis.fr[0].paragraphs.push('La sélection reste incertaine.');
  const result = rejected(value, now(), 'requireCompleteEnglish');
  assert.deepEqual(result.diagnostics, [
    { sourceId: '5795487', field: 'analysis[0].paragraphs', code: 'english_structure_mismatch' },
    { sourceId: '5795487', field: 'analysis[0].paragraphs[1]', code: 'english_field_missing_or_numeric_mismatch' },
  ]);
});

test('API preflight refuses invalid schema, duplicate identities and invalid publisher URLs safely', () => {
  const values = [
    value => { value.categoryId = 'UNTRUSTED_ROOT_FIELD'; },
    value => { value.items.push(clone(value.items[0])); },
    value => { value.items[0].sourceId = { $ne: null }; },
    value => { value.items[0].sourceUrl = 'https://PRIVATE_MARKER@example.invalid/pronostic/match.html'; },
    value => { value.items[0].selection.odds = -2; },
  ];
  for (const alter of values) {
    const value = payload(); alter(value);
    const result = rejected(value);
    assert.equal(result.code, 'api_payload_schema_or_clock_invalid');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(result).includes('PRIVATE_MARKER'), false);
    assert.equal(JSON.stringify(result).includes('UNTRUSTED_ROOT_FIELD'), false);
  }
});

test('API preflight refuses stale, future and impossible edition dates against the supplied actual clock', () => {
  for (const editionDate of ['2026-10-23', '2026-10-25', '2026-02-30']) {
    const value = payload(); value.editionDate = editionDate;
    assert.equal(rejected(value).code, 'api_payload_schema_or_clock_invalid');
  }
  assert.equal(rejected(payload(), new Date('2026-10-25T10:00:00Z')).code, 'api_payload_schema_or_clock_invalid');
});

test('API preflight keeps the thirty-minute publication cutoff and upcoming status', () => {
  const exact = new Date(`${DAY}T15:30:00.000Z`);
  assert.equal(validate(bytes(payload()), exact).passed, true);
  assert.equal(rejected(payload(), new Date(exact.getTime() + 1)).code, 'api_payload_schema_or_clock_invalid');
  for (const status of ['started', 'finished', 'cancelled', 'unknown']) {
    const value = payload(); value.items[0].status = status;
    assert.equal(rejected(value).code, 'api_payload_schema_or_clock_invalid');
  }
});

test('API preflight refuses missing timezone, impossible calendar and a match from another day', () => {
  for (const startsAtUtc of [`${DAY}T16:00:00`, '2026-02-30T16:00:00Z', '2026-10-25T16:00:00Z', null]) {
    const value = payload(); value.items[0].startsAtUtc = startsAtUtc;
    assert.equal(rejected(value).code, 'api_payload_schema_or_clock_invalid');
  }
});

test('API preflight refuses malformed JSON and oversized input without exposing raw input', () => {
  for (const raw of [Buffer.from('{PRIVATE_INVALID_JSON'), Buffer.alloc(4_000_001, ' ')]) {
    const result = rejected(raw);
    assert.equal(result.code, 'api_payload_schema_or_clock_invalid');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(result).includes('PRIVATE_INVALID_JSON'), false);
  }
});
