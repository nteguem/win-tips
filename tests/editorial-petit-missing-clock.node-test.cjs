const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const day = '2026-10-30';
const journal = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74999-le-petit-journal-du-parieur-vendredi-30-octobre-2026.html';
function item() {
  return { sourceId: '6014934', sourceUrl: journal, kind: 'match', title: { fr: 'Toronto — Orlando' },
    summary: { fr: 'Analyse originale du journal.' }, startsAtUtc: '2026-10-31T00:30:00Z', status: 'upcoming',
    sport: { key: 'basketball', name: 'NBA' }, competition: { name: 'NBA' },
    teams: { home: { name: 'Toronto' }, away: { name: 'Orlando' } },
    analysis: { fr: [{ heading: 'Forme', paragraphs: ['Le texte original de la rencontre est conservé.'] }] },
    selection: { label: { fr: 'Victoire Toronto' }, odds: 1.7 }, editionConvention: 'journal_following_day',
    scheduleProof: { sourceUrl: journal, sourceId: '6014934', method: 'rdj_journal_clock', provider: 'rdj',
      editionDate: day, matchedParticipants: ['Toronto', 'Orlando'], startsAtUtc: '2026-10-31T00:30:00Z', status: 'upcoming',
      journalClock: null, detailClock: '2026-10-31T00:30:00', cardClockFallback: { reason: 'kickoff_missing',
        sourceUrl: 'https://www.ruedesjoueurs.com/pronostic/toronto-orlando-6014934.html',
        sourceDate: '2026-10-31', clockPolicy: 'rdj_detail_default_utc' } } };
}
const validate = row => validateBatch({ source: 'rdj_petit_journal', editionDate: day, items: [row] }, new Date(day + 'T10:00:00Z'));
test('a date-only card retains its real null clock and linked detail UTC assumption', () => {
  const before = item(), row = validate(before).items[0];
  assert.equal(row.scheduleProof.journalClock, null);
  assert.equal(row.scheduleProof.detailClock, '2026-10-31T00:30:00');
  assert.deepEqual(row.scheduleProof.cardClockFallback, before.scheduleProof.cardClockFallback);
  assert.deepEqual(row.selection.label, before.selection.label);
  assert.equal(row.selection.odds, before.selection.odds);
});
test('an explicit linked event offset is preserved without inventing a card clock', () => {
  const row = item();
  row.scheduleProof.detailClock = '2026-10-31T01:30:00+01:00';
  row.scheduleProof.cardClockFallback.clockPolicy = 'explicit_event_offset';
  assert.equal(validate(row).items[0].startsAtUtc, '2026-10-31T00:30:00.000Z');
});
test('fallback proof never excuses conflicting clocks, another event, malformed dates or unknown annotations', () => {
  const mutations = [
    row => { delete row.scheduleProof.cardClockFallback; },
    row => { row.scheduleProof.cardClockFallback.reason = 'kickoff_ambiguous'; },
    row => { row.scheduleProof.cardClockFallback.sourceUrl = 'https://attacker.test/match-6014934.html'; },
    row => { row.scheduleProof.cardClockFallback.sourceUrl = row.scheduleProof.cardClockFallback.sourceUrl.replace('6014934', '9999'); },
    row => { row.scheduleProof.cardClockFallback.sourceDate = '2026-10-30'; },
    row => { row.scheduleProof.cardClockFallback.sourceDate = '2026-10-32'; },
    row => { row.scheduleProof.cardClockFallback.sourceDate = '2026-11-01'; },
    row => { row.scheduleProof.cardClockFallback.clockPolicy = 'explicit_event_offset'; },
    row => { row.scheduleProof.cardClockFallback.extra = true; },
    row => { row.scheduleProof.journalClock = '2026-10-31T00:30:00'; },
    row => { row.scheduleProof.detailClock = '2026-10-31T01:30:00'; },
    row => { row.scheduleProof.normalization = {}; },
  ];
  for (const change of mutations) { const row = item(); change(row); assert.throws(() => validate(row)); }
});
test('a corroborated bare 24h remains midnight rather than a missing or thirty-minute clock', () => {
  const row = item(), proof = row.scheduleProof;
  delete proof.cardClockFallback;
  row.startsAtUtc = proof.startsAtUtc = '2026-10-31T00:00:00Z';
  proof.journalClock = proof.detailClock = '2026-10-31T00:00:00';
  proof.normalization = { method: 'rdj_24h_corroborated_v1',
    source_url: 'https://www.ruedesjoueurs.com/pronostic/toronto-orlando-6014934.html',
    raw: '31 octobre 2026 24h', reference: proof.journalClock, normalized: proof.detailClock,
    candidates: ['2026-10-31T00:00:00', '2026-11-01T00:00:00'] };
  assert.equal(validate(row).items[0].startsAtUtc, '2026-10-31T00:00:00.000Z');
  for (const raw of ['31 octobre 2026 24h0', '31 octobre 2026 24h60', '31 octobre 2026 24:']) {
    proof.normalization.raw = raw;
    assert.throws(() => validate(row));
  }
});
