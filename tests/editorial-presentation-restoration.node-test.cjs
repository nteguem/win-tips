const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('../src/api/services/common/editorialValidation');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { planPresentationBackfill, digest } = require('../src/api/services/common/editorialPresentationBackfill');

const day = '2026-11-15', categoryId = '693d4741aacdc474fb9d2675';
const journalUrl = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/75013-le-petit-journal-du-parieur-dimanche-15-novembre-2026.html';
const teams = {
  home: { name: 'France', logo: 'https://img.ruedesjoueurs.com/img/6723-5.png' },
  away: { name: 'Turquie', logo: 'https://img.ruedesjoueurs.com/img/6595-13.png' },
};
function article(date = day) {
  return { source: 'rdj_petit_journal', sourceId: `${date}-card-1`, editionDate: date,
    sourceUrl: journalUrl.replace('15-novembre', `${date.slice(-2)}-novembre`),
    kind: 'article', title: { fr: 'Ligue des Nations A', en: 'Nations League A' },
    summary: { fr: 'Le contexte du jour.', en: 'The daily context.' },
    sport: { key: 'football', name: 'Football' }, startsAtUtc: null, status: 'unknown',
    selection: { label: { fr: 'Turquie +2,5', en: 'Turkey +2.5' }, odds: null },
    analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Le texte original doit rester intact.'] }],
      en: [{ heading: 'Context', paragraphs: ['The original text must remain unchanged.'] }] } };
}
function stored(date = day) {
  const payload = article(date);
  return { _id: '6af9d9f100f91cbdbff7ea7d', categoryId, source: payload.source,
    editionDate: date, sourceId: payload.sourceId, kind: payload.kind, payload,
    contentHash: digest(payload), isPublished: true, notificationState: 'sent',
    createdAt: '2026-11-15T09:00:00Z', updatedAt: '2026-11-15T09:00:00Z' };
}
function fact(date = day) {
  return { sourceId: `${date}-card-1`, editionDate: date, teams, sourceTimeLabel: '21:00',
    proof: { method: 'dated-journal-card', editionDate: date,
      journalUrl: journalUrl.replace('15-novembre', `${date.slice(-2)}-novembre`),
      sourceSha256: 'a'.repeat(64), participantLogos: [teams.home.logo, teams.away.logo] } };
}

test('article validation retains exact source crests and printed clock without inventing UTC', () => {
  const payload = { ...article(), teams, sourceTimeLabel: '21:00',
    artworkUrl: 'https://img.ruedesjoueurs.com/images/pronostic-match/5181799-visuel.jpg' };
  const result = validateBatch({ source: payload.source, editionDate: day, items: [payload] }, new Date(`${day}T22:00:00Z`));
  assert.deepEqual(result.items[0].teams, teams);
  assert.equal(result.items[0].sourceTimeLabel, '21:00');
  assert.equal(result.items[0].startsAtUtc, null);
  assert.equal(result.items[0].artworkUrl, payload.artworkUrl);
  assert.deepEqual(result.items[0].analysis, payload.analysis);
});

test('optional presentation never weakens validation of malformed clocks or other sources', () => {
  for (const sourceTimeLabel of ['24:00', '21h00', '20:99', '', null]) {
    assert.throws(() => validateBatch({ source: 'rdj_petit_journal', editionDate: day,
      items: [{ ...article(), sourceTimeLabel }] }, new Date(`${day}T22:00:00Z`)));
  }
});

test('library exposes presentation but preserves body separation and authorized article short pick preview', async () => {
  const row = stored(); row.payload.teams = teams; row.payload.sourceTimeLabel = '21:00';
  const category = { _id: categoryId, isActive: true, isVip: false,
    editorialSource: 'rdj_petit_journal', name: { fr: 'Le Petit Journal', en: 'The Daily Journal' } };
  const repository = {
    categories: async () => [category], category: async () => category,
    availableDates: async () => [day], items: async () => [row],
    copies: async () => [], reviewSummaries: async () => [], openingCounts: async () => [],
    gate: async () => ({ gated: false, locked: false }),
  };
  const service = createEditorialService({ repository, clock: () => new Date(`${day}T12:00:00Z`) });
  const preview = (await service.library()).categories[0].previewItems[0];
  assert.deepEqual(preview.teams, teams);
  assert.equal(preview.sourceTimeLabel, '21:00');
  for (const key of ['analysis', 'selection', 'selectionPreview', 'payload']) assert.equal(key in preview, false);
  const detail = await service.edition(categoryId, day);
  assert.equal(detail.selectionPreviewsAvailable, true);
  assert.deepEqual(detail.previewItems[0].selectionPreview, { label: 'Turquie +2,5' });
  assert.equal('analysis' in detail.previewItems[0], false);
});

test('metadata backfill handles Nov12 through Nov15 without touching content, IDs, dates or delivery counters', () => {
  for (const number of ['12', '13', '14', '15']) {
    const date = `2026-11-${number}`, row = stored(date);
    const original = structuredClone(row);
    const operations = planPresentationBackfill([row], [fact(date)]);
    assert.equal(operations.length, 1);
    const operation = operations[0].updateOne;
    assert.deepEqual(operations[0].changed, ['teams', 'sourceTimeLabel']);
    assert.deepEqual(Object.keys(operation.update.$set).sort(), ['contentHash', 'payload']);
    assert.equal(operation.filter.contentHash, original.contentHash);
    assert.equal(operation.filter.sourceId, original.sourceId);
    assert.equal(operation.filter.editionDate, date);
    const after = operation.update.$set.payload;
    for (const key of Object.keys(original.payload)) assert.deepEqual(after[key], original.payload[key]);
    assert.deepEqual(after.teams, teams);
    assert.equal(after.sourceTimeLabel, '21:00');
    assert.deepEqual(row, original);
    const applied = { ...row, ...operation.update.$set };
    assert.deepEqual(planPresentationBackfill([applied], [fact(date)]), []);
    assert.equal(applied.notificationState, 'sent');
    assert.equal(applied.createdAt, original.createdAt);
    assert.equal(applied.updatedAt, original.updatedAt);
  }
});

test('backfill rejects stale hashes, wrong opponents and images not on the dated source card', () => {
  const hash = stored(); hash.contentHash = 'b'.repeat(64);
  assert.throws(() => planPresentationBackfill([hash], [fact()]), /hash_mismatch/);
  const opponent = stored(); opponent.payload.teams = { home: { name: 'Belgique' }, away: { name: 'Italie' } };
  opponent.contentHash = digest(opponent.payload);
  assert.throws(() => planPresentationBackfill([opponent], [fact()]), /name_conflict/);
  const proof = fact(); proof.proof.participantLogos = [teams.away.logo, teams.home.logo];
  assert.throws(() => planPresentationBackfill([stored()], [proof]), /participant_proof_mismatch/);
  const stale = fact(); stale.proof.editionDate = '2026-11-14';
  assert.throws(() => planPresentationBackfill([stored()], [stale]), /source_proof_required/);
});

test('backfill replaces only an unspecified sport after source football pair proof', () => {
  const row = stored(); row.payload.sport = { key: 'sport', name: 'sport' };
  row.contentHash = digest(row.payload);
  const value = fact(); value.sport = { key: 'football', name: 'Football' };
  const after = planPresentationBackfill([row], [value])[0].updateOne.update.$set.payload;
  assert.deepEqual(after.sport, value.sport);
  assert.deepEqual(after.analysis, row.payload.analysis);
  row.payload.sport = { key: 'tennis', name: 'Tennis' }; row.contentHash = digest(row.payload);
  assert.throws(() => planPresentationBackfill([row], [value]), /sport_conflict/);
});
