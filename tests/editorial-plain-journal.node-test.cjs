const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch, completeEnglishWithFallback, requireCompleteEnglish } = require('../src/api/services/common/editorialValidation');
const day = '2026-11-12';
function batch() {
  return { source: 'rdj_petit_journal', editionDate: day, items: [{
    sourceId: day + '-analysis-1', sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74997-le-petit-journal-du-parieur-jeudi-12-novembre-2026.html',
    kind: 'article', title: { fr: 'Italie — France' }, summary: { fr: 'Les analyses du jour.' },
    sport: { key: 'football', name: 'Football' }, startsAtUtc: null, status: 'unknown',
    selection: { label: { fr: 'Olise décisif' }, odds: null },
    analysis: { fr: [{ heading: 'Analyse', paragraphs: ['Texte éditorial sans résultat à calculer.'] }] }
  }] };
}
test('Petit Journal text publishes all day without result, clock, odds or parsed market', () => {
  for (const hour of [6, 15, 22]) {
    const result = validateBatch(batch(), new Date(day + 'T' + String(hour).padStart(2, '0') + ':00:00Z'));
    assert.equal(result.items[0].kind, 'article');
    assert.equal(result.items[0].startsAtUtc, null);
    completeEnglishWithFallback(result.items);
    assert.doesNotThrow(() => requireCompleteEnglish(result.items));
  }
});
test('text exception cannot weaken paid ticket or other source validation', () => {
  const value = batch(); value.source = 'rdj_football_analysis';
  assert.throws(() => validateBatch(value, new Date(day + 'T08:00:00Z')));
});
test('a dated journal never admits another day or HTML content', () => {
  const wrong = batch(); wrong.items[0].sourceUrl = wrong.items[0].sourceUrl.replace('jeudi-12', 'mercredi-11');
  assert.throws(() => validateBatch(wrong, new Date(day + 'T08:00:00Z')));
  const html = batch(); html.items[0].analysis.fr[0].paragraphs = ['<script>bad()</script>'];
  assert.throws(() => validateBatch(html, new Date(day + 'T08:00:00Z')));
});
