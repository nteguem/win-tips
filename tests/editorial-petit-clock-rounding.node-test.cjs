'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const { normalizePetitJournalClockReconciliation } = require('../src/api/services/common/petitJournalClockProof');

const DAY = '2026-11-07';
const NOW = new Date(DAY + 'T03:00:00Z');
const JOURNAL = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74939-le-petit-journal-du-parieur-samedi-7-novembre-2026.html';
function item(next = false) {
  const day = next ? '2026-11-08' : DAY;
  const journalClock = day + (next ? 'T00:30:00' : 'T21:00:00');
  const detailClock = day + (next ? 'T00:35:00' : 'T21:05:00');
  const row = { source: 'rdj_petit_journal', sourceId: '5802987', sourceUrl: JOURNAL,
    editionDate: DAY, kind: 'match', title: { fr: 'PSG - Troyes' }, summary: { fr: 'Une analyse du match.' },
    startsAtUtc: detailClock + 'Z', sport: { key: 'football', name: 'Football' }, competition: { name: 'Ligue 1' },
    teams: { home: { name: 'PSG', logo: 'https://img.ruedesjoueurs.com/img/101-1.png' },
      away: { name: 'Troyes', logo: 'https://img.ruedesjoueurs.com/img/102-1.png' } },
    analysis: { fr: [{ heading: 'Le match', paragraphs: ['Une analyse de la rencontre.'] }] },
    selection: { label: { fr: 'Victoire PSG' }, odds: 1.3 }, status: 'upcoming' };
  const proof = { method: 'rdj_detail_clock_rounding_v1', sourceUrl: JOURNAL,
    detailSourceUrl: 'https://www.ruedesjoueurs.com/pronostic/psg-troyes-5802987.html', sourceId: row.sourceId,
    matchedParticipants: ['PSG', 'Troyes'], participantLogoIds: ['101', '102'], sport: 'football', competition: 'Ligue 1',
    startsAtUtc: row.startsAtUtc, journalClock, detailClock, assumedTimezone: 'UTC', timezoneAssumed: true,
    deltaSeconds: 300, limitSeconds: 300, journalRoundingMinutes: 15, preferredClock: 'detail',
    identityChecks: { orderedParticipants: true, competition: true, calendarDate: true } };
  if (next) {
    row.editionConvention = 'journal_following_day';
    row.scheduleProof = { sourceUrl: JOURNAL, sourceId: row.sourceId, method: 'rdj_journal_clock', provider: 'rdj',
      editionDate: DAY, matchedParticipants: ['PSG', 'Troyes'], startsAtUtc: row.startsAtUtc, status: 'upcoming',
      journalClock, detailClock, clockReconciliation: proof };
  } else row.clockReconciliation = proof;
  return row;
}
const proofOf = row => row.clockReconciliation || row.scheduleProof.clockReconciliation;
const batch = row => ({ source: 'rdj_petit_journal', editionDate: DAY, items: [row] });

test('same-day and following-day Petit Journal retain original rounded card and precise detail clocks', () => {
  for (const next of [false, true]) {
    const row = item(next), result = validateBatch(batch(row), NOW).items[0];
    assert.deepEqual(proofOf(result), { ...proofOf(row), startsAtUtc: new Date(row.startsAtUtc).toISOString() });
    assert.equal(result.startsAtUtc, new Date(proofOf(row).detailClock + 'Z').toISOString());
    assert.notEqual(proofOf(result).journalClock, proofOf(result).detailClock);
  }
});

test('bounded positive and negative minute differences use detailed UTC rather than a Paris reinterpretation', () => {
  for (const minutes of [-5, -1, 1, 5]) {
    const row = item(), proof = proofOf(row);
    proof.detailClock = new Date(Date.parse(proof.journalClock + 'Z') + minutes * 60000).toISOString().slice(0, 19);
    proof.deltaSeconds = minutes * 60; row.startsAtUtc = proof.startsAtUtc = proof.detailClock + 'Z';
    const result = validateBatch(batch(row), NOW).items[0];
    assert.equal(result.startsAtUtc, new Date(row.startsAtUtc).toISOString());
  }
});

test('all-zero fractional seconds preserve the exact minute in the bounded proof', () => {
  for (const next of [false, true]) {
    const row = item(next), proof = proofOf(row);
    proof.journalClock += '.000000'; proof.detailClock += '.000000';
    proof.startsAtUtc = row.startsAtUtc.replace('Z', '.000000Z');
    if (next) { row.scheduleProof.journalClock = proof.journalClock; row.scheduleProof.detailClock = proof.detailClock; }
    assert.equal(validateBatch(batch(row), NOW).items[0].startsAtUtc, new Date(row.startsAtUtc).toISOString());
  }
});

test('coherently bound clock evidence cannot relax the limit, whole minutes or calendar boundary', () => {
  const clocks = [
    ['2026-11-07T21:00:00', '2026-11-07T21:06:00'],
    ['2026-11-07T21:00:00', '2026-11-07T20:54:00'],
    ['2026-11-07T21:00:00', '2026-11-07T22:00:00'],
    ['2026-11-07T21:00:00', '2026-11-07T21:00:00'],
    ['2026-11-07T21:01:00', '2026-11-07T21:05:00'],
    ['2026-11-08T00:00:00', '2026-11-07T23:55:00'],
    ['2026-11-07T21:00:00.000001', '2026-11-07T21:05:00'],
    ['2026-11-07T21:00:00', '2026-11-07T21:05:00.000001'],
  ];
  for (const [journalClock, detailClock] of clocks) {
    const row = item(), proof = proofOf(row);
    proof.journalClock = journalClock; proof.detailClock = detailClock;
    proof.deltaSeconds = (Date.parse(detailClock + 'Z') - Date.parse(journalClock + 'Z')) / 1000;
    row.startsAtUtc = new Date(Date.parse(detailClock + 'Z')).toISOString(); proof.startsAtUtc = row.startsAtUtc;
    assert.throws(() => normalizePetitJournalClockReconciliation(proof, row), `${journalClock} / ${detailClock}`);
  }
});

const changes = [
  ['wrong method', (r, p) => { p.method = 'general_tolerance'; }],
  ['foreign journal host', (r, p) => { p.sourceUrl = p.sourceUrl.replace('www.ruedesjoueurs.com', 'outside.invalid'); }],
  ['journal query', (r, p) => { p.sourceUrl += '?ignored=1'; }],
  ['wrong dated journal', (r, p) => { p.sourceUrl = p.sourceUrl.replace('7-novembre', '6-novembre'); }],
  ['wrong detailed ID', (r, p) => { p.detailSourceUrl = p.detailSourceUrl.replace('5802987', '5802988'); }],
  ['wrong source ID', (r, p) => { p.sourceId = '5802988'; }],
  ['foreign detail host', (r, p) => { p.detailSourceUrl = p.detailSourceUrl.replace('www.ruedesjoueurs.com', 'outside.invalid'); }],
  ['detail query', (r, p) => { p.detailSourceUrl += '?ignored=1'; }],
  ['participants reversed', (r, p) => { p.matchedParticipants.reverse(); }],
  ['participants changed', (r, p) => { p.matchedParticipants[0] = 'Another club'; }],
  ['logos reversed', (r, p) => { p.participantLogoIds.reverse(); }],
  ['foreign item logo', r => { r.teams.home.logo = 'https://outside.invalid/img/101-1.png'; }],
  ['duplicate logos', (r, p) => { p.participantLogoIds[1] = '101'; r.teams.away.logo = r.teams.home.logo; }],
  ['wrong sport', (r, p) => { p.sport = 'tennis'; }],
  ['wrong competition', (r, p) => { p.competition = 'Another league'; }],
  ['UTC proof shifted', (r, p) => { p.startsAtUtc = DAY + 'T20:05:00Z'; }],
  ['item shifted from detailed UTC', r => { r.startsAtUtc = DAY + 'T20:05:00Z'; }],
  ['timezone changed', (r, p) => { p.assumedTimezone = 'Europe/Paris'; }],
  ['timezone assumption changed', (r, p) => { p.timezoneAssumed = false; }],
  ['increased configurable limit', (r, p) => { p.limitSeconds = 3600; }],
  ['changed rounding interval', (r, p) => { p.journalRoundingMinutes = 30; }],
  ['prefers rounded card', (r, p) => { p.preferredClock = 'journal'; }],
  ['identity not proven', (r, p) => { p.identityChecks.orderedParticipants = false; }],
  ['identity bool coercion', (r, p) => { p.identityChecks.competition = 1; }],
  ['identity extra field', (r, p) => { p.identityChecks.unbounded = true; }],
  ['envelope extra field', (r, p) => { p.extra = true; }],
  ['missing clock', (r, p) => { delete p.journalClock; }],
  ['offset journal clock', (r, p) => { p.journalClock += '+00:00'; }],
  ['offset detail clock', (r, p) => { p.detailClock += '+00:00'; }],
  ['journal not quarter-hour', (r, p) => { p.journalClock = p.journalClock.replace(':00:00', ':01:00').replace(':30:00', ':31:00'); p.deltaSeconds = 240; }],
  ['journal seconds', (r, p) => { p.journalClock = p.journalClock.slice(0, -2) + '01'; p.deltaSeconds = 299; }],
  ['detail seconds', (r, p) => { p.detailClock = p.detailClock.slice(0, -2) + '01'; }],
  ['journal microseconds', (r, p) => { p.journalClock += '.000001'; }],
  ['detail microseconds', (r, p) => { p.detailClock += '.000001'; }],
  ['UTC proof microseconds', (r, p) => { p.startsAtUtc = p.startsAtUtc.replace('Z', '.000001Z'); }],
  ['delta coercion', (r, p) => { p.deltaSeconds = '300'; }],
  ['delta does not match clocks', (r, p) => { p.deltaSeconds = 240; }],
  ['calendar disagreement', (r, p) => { p.journalClock = '2026-11-06T23:45:00'; }],
  ['more than five minutes', (r, p) => { p.detailClock = p.detailClock.slice(0, -5) + '06:00'; p.deltaSeconds = 360; }],
  ['zero difference', (r, p) => { p.detailClock = p.journalClock; p.deltaSeconds = 0; }],
  ['timezone sized disagreement', (r, p) => { p.detailClock = p.detailClock.replace('T21:', 'T22:').replace('T00:', 'T01:'); p.deltaSeconds = 3900; }],
];
for (const next of [false, true]) for (const [name, change] of changes) {
  test(`${next ? 'following' : 'same'} day rejects ${name}`, () => {
    const row = item(next); change(row, proofOf(row));
    assert.throws(() => validateBatch(batch(row), NOW));
  });
}

test('following-day reconciliation must remain bound to its schedule proof clocks', () => {
  for (const change of [r => { r.scheduleProof.journalClock = '2026-11-08T00:45:00'; },
    r => { r.scheduleProof.detailClock = '2026-11-08T00:40:00'; },
    r => { r.scheduleProof.clockReconciliation = null; },
    r => { r.scheduleProof.normalization = {}; },
    r => { r.scheduleProof.cardClockFallback = {}; },
    r => { r.clockReconciliation = proofOf(r); }]) {
    const row = item(true); change(row); assert.throws(() => validateBatch(batch(row), NOW));
  }
});

test('without an explicit rounding proof following-day unequal clocks remain invalid', () => {
  const row = item(true); delete row.scheduleProof.clockReconciliation;
  assert.throws(() => validateBatch(batch(row), NOW));
});

test('a rounding proof cannot be attached to another editorial source', () => {
  const row = item(); row.source = 'rdj_football_analysis'; row.sourceUrl = proofOf(row).detailSourceUrl;
  assert.throws(() => normalizePetitJournalClockReconciliation(proofOf(row), row));
  assert.throws(() => validateBatch({ source: row.source, editionDate: DAY, items: [row] }, NOW));
});
