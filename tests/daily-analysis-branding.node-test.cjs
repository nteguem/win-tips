const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DAILY_ANALYSIS_SOURCE, categoryDisplayName, productTitle, payloadPresentation } = require('../src/api/services/common/editorialProductNames');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { message, notificationId } = require('../src/api/services/common/editorialNotifications');
const { sourceByKey } = require('../src/api/services/common/editorialSources');

const date = '2026-11-17', categoryId = 'a'.repeat(24), itemId = 'b'.repeat(24);
function fixture() {
  const category = { _id: categoryId, isActive: true, isVip: false, editorialSource: DAILY_ANALYSIS_SOURCE,
    name: { fr: 'Journal du Parieur', en: 'The Daily Journal' } };
  const payload = { source: DAILY_ANALYSIS_SOURCE, sourceId: 'test-17', editionDate: date, kind: 'article',
    sourceUrl: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html',
    title: { fr: 'Le Petit Journal du Parieur · 17 novembre', en: 'The Daily Journal · 17 November' },
    summary: { fr: 'Le Petit Journal évoque la forme de France.', en: 'The Daily Journal discusses France’s form.' },
    analysis: { fr: [{ heading: 'France — Italie', paragraphs: ['Le Petit Journal explique la dynamique des équipes.'] }],
      en: [{ heading: 'France — Italy', paragraphs: ['The Daily Journal explains the teams’ form.'] }] },
    sport: { key: 'football', name: 'Football' }, status: 'unknown', startsAtUtc: null,
    selection: { label: { fr: 'France', en: 'France' }, odds: null } };
  const row = { _id: itemId, categoryId, source: DAILY_ANALYSIS_SOURCE, sourceId: payload.sourceId,
    editionDate: date, payload, isPublished: true, contentHash: 'unchanged' };
  const repository = {
    categories: async () => [category], category: async () => category,
    items: async () => [row], item: async () => row, availableDates: async () => [date],
    reviewSummaries: async () => [], openingCounts: async () => [], copies: async () => [],
    hasAnySubscription: async () => false, hasCategoryAccess: async () => false,
    gate: async () => ({ gated: false, locked: false, offers: [], state: null, unlockCount: 0 }),
  };
  const service = createEditorialService({ repository, clock: () => new Date(date + 'T10:00:00Z') });
  return { category, payload, row, repository, service };
}

test('only the Petit Journal source receives the bilingual product name', () => {
  for (const oldName of ['Le Petit Journal', 'Le Petit Journal du Parieur', 'Journal du Parieur', 'The Daily Journal']) {
    const category = { editorialSource: DAILY_ANALYSIS_SOURCE, name: oldName };
    assert.equal(categoryDisplayName(category, 'fr'), 'Analyse du jour');
    assert.equal(categoryDisplayName(category, 'en'), 'Daily Analysis');
  }
  assert.equal(categoryDisplayName({ editorialSource: 'rdj_tennis', name: 'Journal du Parieur' }, 'fr'), 'Journal du Parieur');
  assert.equal(categoryDisplayName({ editorialSource: 'wintips_daily_vip', name: 'Combiné du jour' }, 'fr'), 'Combiné du jour');
  assert.equal(sourceByKey(DAILY_ANALYSIS_SOURCE).url, 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html');
});

test('strict title aliases change at read time while match names, prose and stored identity remain intact', () => {
  const { payload } = fixture();
  const before = JSON.stringify(payload);
  const presentation = payloadPresentation(payload, 'fr');
  assert.equal(presentation.title.fr, 'Analyse du jour · 17 novembre');
  assert.equal(presentation.title.en, 'Daily Analysis · 17 November');
  assert.equal(JSON.stringify(payload), before);
  assert.equal(presentation.analysis, payload.analysis);
  assert.equal(presentation.summary, payload.summary);
  assert.equal(presentation.sourceUrl, payload.sourceUrl);
  assert.equal(presentation.sourceId, payload.sourceId);
  for (const name of ['France — Italie', 'Journal du parieurisme', 'Le Petit Journaliste gagne', 'Un article dans Le Petit Journal',
    'Le Petit Journal analyse France — Italie', 'Journal du Parieur : France — Italie', 'Journal du Parieur gagne 3-0',
    'The Daily Journal: France v Italy', 'Le Petit Journal · 2026-02-31', 'Le Petit Journal du 35 novembre',
    'Le Petit Journal · 17 novembre · 4 analyses', 'Le Petit Journal: profitez des pronostics']) {
    assert.equal(productTitle(name, DAILY_ANALYSIS_SOURCE, 'fr'), name);
  }
  assert.equal(productTitle('Le Petit Journal', 'rdj_turf_quinte', 'fr'), 'Le Petit Journal');
  assert.equal(productTitle("The Bettor's Journal", DAILY_ANALYSIS_SOURCE, 'en'), 'Daily Analysis');
  assert.equal(productTitle('The Bettors’ Journal', DAILY_ANALYSIS_SOURCE, 'en'), 'Daily Analysis');
  for (const suffix of [' · 17 novembre', ' — 2026-11-17', ' du mardi 17 novembre 2026',
    ' - November 17, 2026', ' (17 Nov. 2026)', ' : 17/11/2026']) {
    assert.equal(productTitle('Le Petit Journal' + suffix, DAILY_ANALYSIS_SOURCE, 'fr'), 'Analyse du jour' + suffix);
    assert.equal(productTitle('The Daily Journal' + suffix, DAILY_ANALYSIS_SOURCE, 'en'), 'Daily Analysis' + suffix);
  }
});

test('library, edition, feed and full reader present existing database names without writes', async () => {
  const { category, payload, row, service } = fixture();
  const before = JSON.stringify({ category, row });
  for (const lang of ['fr', 'en']) {
    const expected = lang === 'fr' ? 'Analyse du jour' : 'Daily Analysis';
    const card = (await service.library({ lang })).categories[0];
    assert.equal(card.name, expected); assert.equal(card.source.label, expected);
    assert.equal(card.previewItems[0].title[lang].startsWith(expected), true);
    const edition = await service.edition(categoryId, date, { lang });
    assert.equal(edition.name, expected); assert.equal(edition.source.label, expected);
    const feed = (await service.feed({ lang })).categories[0];
    assert.equal(feed.name, expected); assert.equal(feed.source.label, expected);
    const content = await service.content(categoryId, date, { lang });
    assert.equal(content.items[0].title[lang].startsWith(expected), true);
    const article = await service.analysis(itemId, { lang });
    assert.equal(article.title[lang].startsWith(expected), true);
    assert.deepEqual(article.analysis, payload.analysis);
    assert.equal(service.catalog(lang).find(row => row.key === DAILY_ANALYSIS_SOURCE).label, expected);
  }
  assert.equal(JSON.stringify({ category, row }), before);
});

test('new notifications use the product name while their identity and destination stay unchanged', () => {
  const { category, row } = fixture();
  const group = { category, source: DAILY_ANALYSIS_SOURCE, editionDate: date, items: [row] };
  const stableId = notificationId('wintips', group);
  for (const lang of ['fr', 'en']) {
    const notification = message('wintips', group, lang);
    assert.equal(notification.id, stableId);
    assert.equal(notification.title, lang === 'fr'
      ? 'Analyse du jour disponible · 17 novembre'
      : 'Daily Analysis is ready · 17 November');
    assert.doesNotMatch(notification.title, /Petit Journal|Daily Journal|Journal du Parieur/);
    assert.equal(notification.extra.categoryId, categoryId);
    assert.equal(notification.extra.itemId, itemId);
    assert.equal(notification.extra.editionDate, date);
    assert.equal(notification.extra.isVip, 'false');
    assert.equal(notification.extra.action, 'view_editorial');
    assert.equal(notification.requiresVip, false);
  }
});

test('category serialization updates public names while the raw database field remains unchanged', () => {
  const Category = require('../src/api/models/common/Category');
  const doc = new Category({ name: { fr: 'Le Petit Journal', en: 'The Daily Journal' },
    editorialSource: DAILY_ANALYSIS_SOURCE, isVip: false, isActive: true });
  assert.equal(doc.formatForLanguage('fr').name, 'Analyse du jour');
  assert.equal(doc.formatForLanguage('en').name, 'Daily Analysis');
  assert.equal(doc.name.fr, 'Le Petit Journal');
  assert.equal(doc.name.en, 'The Daily Journal');
});

test('future catalogue examples use the new name without changing source keys or other sports', () => {
  for (const file of ['editorial-catalogue.example.json', 'editorial-catalogue.nba.example.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../tools', file)));
    assert.deepEqual(config.categories.find(row => row.source === DAILY_ANALYSIS_SOURCE).name,
      { fr: 'Analyse du jour', en: 'Daily Analysis' });
    const turf = config.categories.find(row => row.source === 'rdj_turf_quinte');
    assert.match(turf.name.fr, /Quinté/);
  }
});

test('the anonymous category catalogue projects the name without writing or affecting other sports', async () => {
  const Category = require('../src/api/models/common/Category');
  const { listAllCategories } = require('../src/api/controllers/common/publicCatalogController');
  const original = Category.find;
  const { category } = fixture();
  const rows = [category, { _id: 'c'.repeat(24), editorialSource: 'rdj_turf_quinte',
    name: { fr: 'Le Quinté du Jour', en: 'The Daily Quinté' }, isVip: false }];
  const before = JSON.stringify(rows);
  Category.find = filter => {
    assert.deepEqual(filter, { isActive: true });
    return { select: fields => {
      assert.match(fields, /editorialSource/);
      return { sort: () => ({ lean: async () => rows }) };
    } };
  };
  try {
    for (const lang of ['fr', 'en']) {
      let actual, status;
      const response = { status: code => { status = code; return response; }, json: body => { actual = body; } };
      await listAllCategories({ query: { lang } }, response);
      assert.equal(status, 200);
      assert.equal(actual.data[0].name, lang === 'fr' ? 'Analyse du jour' : 'Daily Analysis');
      assert.equal(actual.data[1].name, lang === 'fr' ? 'Le Quinté du Jour' : 'The Daily Quinté');
    }
    assert.equal(JSON.stringify(rows), before);
  } finally { Category.find = original; }
});
