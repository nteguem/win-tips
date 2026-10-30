const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const day = '2026-10-30';
const journal = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74999-le-petit-journal-du-parieur-vendredi-30-octobre-2026.html';
const clone = value => JSON.parse(JSON.stringify(value));
function item(sport = 'basketball') {
  return { sourceId: '6014934', sourceUrl: journal, kind: 'match',
    title: { fr: 'Toronto — Orlando' }, summary: { fr: 'Une analyse originale du journal.' },
    startsAtUtc: '2026-10-31T00:30:00Z', status: 'upcoming', sport: { key: sport, name: sport },
    competition: { name: sport === 'basketball' ? 'NBA' : 'ATP' }, teams: { home: { name: 'Toronto' }, away: { name: 'Orlando' } },
    analysis: { fr: [{ heading: 'Forme', paragraphs: ['Paragraphe source intégral conservé.'] }] },
    selection: { label: { fr: 'Victoire Toronto' }, odds: 1.7 }, editionConvention: 'journal_following_day',
    scheduleProof: { sourceUrl: journal, sourceId: '6014934', method: 'rdj_journal_clock', provider: 'rdj',
      editionDate: day, matchedParticipants: ['Toronto', 'Orlando'], startsAtUtc: '2026-10-31T00:30:00Z', status: 'upcoming',
      journalClock: '2026-10-31T00:30:00', detailClock: '2026-10-31T00:30:00', normalization: {
        method: 'rdj_24h_corroborated_v1', source_url: 'https://www.ruedesjoueurs.com/pronostic/toronto-orlando-6014934.html',
        raw: '31 octobre 2026 24h30', reference: '2026-10-31T00:30:00', normalized: '2026-10-31T00:30:00',
        candidates: ['2026-10-31T00:30:00', '2026-11-01T00:30:00'] } } };
}
const validate = (row, source = 'rdj_petit_journal') => validateBatch({ source, editionDate: day, items: [row] }, new Date(day + 'T10:00:00Z'));

test('the dated Petit owns its next-day NBA card with the corroborated 24h clock metadata', () => {
  const row = item(), before = clone(row);
  const actual = validate(row).items[0];
  assert.equal(actual.editionDate, day);
  assert.equal(actual.startsAtUtc, '2026-10-31T00:30:00.000Z');
  assert.equal(actual.scheduleProof.method, 'rdj_journal_clock');
  assert.deepEqual(actual.scheduleProof.normalization, row.scheduleProof.normalization);
  assert.deepEqual(actual.analysis, row.analysis);
  assert.equal(actual.selection.odds, 1.7);
  assert.deepEqual(row, before);
});
test('Petit next-day membership applies to its own tennis/rugby programme and is not limited to NBA mornings', () => {
  for (const sport of ['tennis', 'rugby', 'volleyball']) {
    const row = item(sport);
    row.startsAtUtc = row.scheduleProof.startsAtUtc = '2026-10-31T14:30:00Z';
    row.scheduleProof.journalClock = row.scheduleProof.detailClock = '2026-10-31T14:30:00';
    delete row.scheduleProof.normalization;
    assert.equal(validate(row).items[0].sport.key, sport);
  }
});
test('date, identity, event clocks and participants remain bound to the exact journal', () => {
  const invalid = [
    row => { delete row.scheduleProof; }, row => { delete row.editionConvention; },
    row => { row.startsAtUtc = row.scheduleProof.startsAtUtc = '2026-11-01T00:30:00Z'; },
    row => { row.scheduleProof.sourceId = '9999'; }, row => { row.scheduleProof.editionDate = '2026-10-29'; },
    row => { row.scheduleProof.sourceUrl = journal.replace('30-octobre', '29-octobre'); },
    row => { row.sourceUrl = row.scheduleProof.sourceUrl = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html'; },
    row => { row.scheduleProof.sourceUrl = 'https://attacker.example/journal.html'; },
    row => { row.scheduleProof.matchedParticipants.reverse(); }, row => { row.scheduleProof.status = 'finished'; },
    row => { row.scheduleProof.journalClock = '2026-10-31T00:31:00'; },
    row => { row.scheduleProof.detailClock = '2026-10-31T24:30:00'; },
    row => { row.scheduleProof.normalization.reference = '2026-10-30T00:30:00'; },
    row => { row.scheduleProof.normalization.source_url = row.scheduleProof.normalization.source_url.replace('6014934', '9999'); },
    row => { row.scheduleProof.normalization.candidates.reverse(); },
    row => { row.scheduleProof.normalization.raw = '31 octobre 2026 24h59'; },
    row => { row.scheduleProof.normalization.raw = '30 octobre 2026 24h30'; },
  ];
  for (const mutate of invalid) { const row = item(); mutate(row); assert.throws(() => validate(row)); }
});
test('a journal proof cannot relax another source or bypass the existing VIP NBA schedule proof', () => {
  for (const source of ['rdj_multisport_analysis', 'rdj_football_analysis']) {
    const row = item(); row.sourceUrl = 'https://www.ruedesjoueurs.com/pronostic/toronto-orlando-6014934.html';
    assert.throws(() => validate(row, source));
  }
  const row = item(); row.startsAtUtc = row.scheduleProof.startsAtUtc = day + 'T19:30:00Z';
  assert.throws(() => validate(row));
});
