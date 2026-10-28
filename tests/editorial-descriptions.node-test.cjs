'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const { factsFromBatch, digest, renderV2, V2_VERSION, fallback } = require('../src/api/services/common/editorialCopy');
const { VERSION, sortedFacts } = require('../src/api/services/common/couponTeaser');
const { editorialDescriptionFields } = require('../src/api/services/common/editorialDescriptions');
const day = '2026-10-28', categoryId = 'a'.repeat(24), user = { _id: 'b'.repeat(24) };
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(vip = false) {
  const source = vip ? 'rdj_football_analysis' : 'rdj_petit_journal';
  const items = ['Marseille', 'Paris', 'Lyon'].map((name, index) => ({ source, sourceId: String(index + 101), editionDate: day,
    kind: 'match', title: { fr: name + ' — Adversaire', en: name + ' — Opponent' },
    startsAtUtc: day + 'T18:00:00.000Z', sport: { key: 'football', name: 'Football' }, competition: { name: 'Ligue 1' },
    teams: { home: { name }, away: { name: 'Adversaire ' + index } }, status: 'upcoming',
    summary: { fr: name + ' reste sur 4 victoires.', en: name + ' have recorded 4 wins.' },
    analysis: { fr: [{ heading: 'Analyse', paragraphs: [name + ' reste sur 4 victoires.', 'DÉTAIL PRIVÉ réservé au lecteur.'] }],
      en: [{ heading: 'Analysis', paragraphs: [name + ' have recorded 4 wins.', 'PRIVATE DETAIL reserved for readers.'] }] },
    selection: { label: { fr: 'Victoire ' + name, en: name + ' to win' }, odds: 1.85 },
  }));
  const facts = factsFromBatch({ source, editionDate: day, items });
  const choice = { angle: 'context', focusIds: facts.items.map(row => row.id), entries: facts.items.map(row => ({ id: row.id,
    description: { fr: row.home + ' retrouve son public après une série de quatre victoires.',
      en: row.home + ' are back with their fans after four consecutive victories.' },
    notification: { fr: row.home + ' reste sur 4 victoires.', en: row.home + ' have recorded 4 wins.' },
  })) };
  const copy = { version: V2_VERSION, sourceHash: digest(facts), sourceIds: choice.focusIds, choice,
    body: renderV2(facts, choice), notificationBody: renderV2(facts, choice, 'notification'), method: 'gemini',
    model: 'gemini-3.5-flash-lite', cacheKey: '1'.repeat(64), nativeSha256: '2'.repeat(64) };
  const rows = items.map((payload, index) => ({ _id: String(index + 1).padStart(24, '0'), categoryId, source, editionDate: day,
    sourceId: payload.sourceId, payload, isPublished: true, contentHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
  const teaser = { version: VERSION, sourceHash: digest(sortedFacts(facts)), body: {
    fr: 'Les séries de victoires éclairent les rencontres de cette édition.',
    en: 'Winning runs set the scene for the matches in this edition.',
  } };
  const record = { _id: `wintips:${source}:${day}`, appId: 'wintips', source, editionDate: day, initialized: true, legacy: false,
    copy, copySha256: digest(copy), itemHashes: rows.map(row => ({ sourceId: row.sourceId, contentHash: row.contentHash })), couponTeaser: teaser };
  const state = { access: false, copies: [record] };
  const category = { _id: categoryId, isActive: true, isVip: vip, editorialSource: source, name: { fr: 'Journal', en: 'Journal' } };
  const repository = { categories: async () => [category], category: async () => category, items: async () => rows,
    copies: async () => state.copies, reviewSummaries: async () => [], availableDates: async () => [day],
    hasCategoryAccess: async () => state.access, hasAnySubscription: async () => false, gate: async () => ({ locked: false, gated: false }) };
  return { rows, items, facts, copy, teaser, record, state, repository,
    service: createEditorialService({ repository, clock: () => new Date(day + 'T08:00:00Z') }) };
}

test('library, detail and legacy feed return the same localized short and long descriptions', async () => {
  const h = fixture(), before = clone({ rows: h.rows, record: h.record });
  for (const lang of ['fr', 'en']) {
    for (const card of [(await h.service.library({ lang })).categories[0], await h.service.edition(categoryId, day, { lang }),
      (await h.service.feed({ lang })).categories[0]]) {
      assert.equal(card.description, h.teaser.body[lang]);
      assert.equal(card.editorialDescription, card.description);
      assert.equal(card.shortDescription, card.description);
      assert.equal(card.longDescription, h.copy.body[lang]);
      assert.ok([...card.shortDescription].length <= 100);
      assert.ok(card.longDescription.length > card.shortDescription.length);
      assert.doesNotMatch(card.longDescription, /PRIVÉ|PRIVATE|1\.85|to win|Victoire Marseille/);
    }
  }
  assert.deepEqual({ rows: h.rows, record: h.record }, before);
});

test('VIP descriptions remain public copy while full reader analysis and selections stay protected', async () => {
  const h = fixture(true);
  const card = await h.service.edition(categoryId, day);
  assert.equal(card.locked, true); assert.equal(card.requiresAuth, true);
  assert.equal(card.longDescription, h.copy.body.fr);
  assert.equal(JSON.stringify(card).includes('DÉTAIL PRIVÉ'), false);
  await assert.rejects(h.service.content(categoryId, day), { statusCode: 401 });
  await assert.rejects(h.service.content(categoryId, day, { user }), { statusCode: 403 });
  const feed = (await h.service.feed({ isVip: true, user })).categories[0];
  assert.equal(feed.locked, true); assert.equal(feed.longDescription, h.copy.body.fr);
  assert.equal(JSON.stringify(feed).includes('DÉTAIL PRIVÉ'), false);
  h.state.access = true;
  const reader = await h.service.content(categoryId, day, { user });
  assert.equal(reader.items[0].analysis.fr[0].paragraphs[1], 'DÉTAIL PRIVÉ réservé au lecteur.');
  assert.equal(reader.items[0].selection.odds, 1.85);
});

test('a legacy V1 copy without a generated short caption retains a separate long version', async () => {
  const h = fixture(); h.record.copy = fallback(h.facts); h.record.copySha256 = digest(h.record.copy); delete h.record.couponTeaser;
  for (const lang of ['fr', 'en']) {
    const card = await h.service.edition(categoryId, day, { lang });
    assert.equal(card.shortDescription, card.description);
    assert.equal(card.longDescription, h.record.copy.body[lang]);
    assert.notEqual(card.longDescription, card.shortDescription);
  }
});

test('missing or stale copy falls back to screened public source context without raw reader paragraphs', async () => {
  for (const stale of [false, true]) {
    const h = fixture();
    if (stale) h.record.copySha256 = '0'.repeat(64); else h.state.copies = [];
    const card = await h.service.edition(categoryId, day);
    assert.match(card.longDescription, /Marseille.*Paris.*Lyon/);
    assert.doesNotMatch(card.longDescription, /PRIVÉ|PRIVATE|Victoire Marseille|1\.85/);
    assert.equal(card.shortDescription, card.description);
  }
});

test('a generated long hook that exposes a VIP selection is replaced with safe public context', async () => {
  const h = fixture(true);
  h.copy.choice.entries[0].description = { fr: 'Notre choix : Victoire Marseille.', en: 'Our pick: Marseille to win.' };
  h.copy.body = renderV2(h.facts, h.copy.choice); h.record.copySha256 = digest(h.copy);
  for (const lang of ['fr', 'en']) {
    const card = await h.service.edition(categoryId, day, { lang });
    assert.equal(card.shortDescription, h.teaser.body[lang]);
    assert.doesNotMatch(card.longDescription, /Notre choix|Our pick|Victoire Marseille|to win/);
  }
});

test('race descriptions do not expose a runner mentioned by generated commentary', () => {
  const rows = [{ payload: { kind: 'horse_racing', race: { name: 'Prix du Test', racecourse: 'Longchamp',
    meetingNumber: 1, raceNumber: 5, distanceMeters: 2500, runnersCount: 16,
    runners: [{ number: 7, name: 'JANAH' }] }, analysis: { fr: [{ paragraphs: ['JANAH reste notre base.'] }] },
    selection: { label: { fr: 'Selection de la course' }, orderedNumbers: [7] } } }];
  const descriptions = editorialDescriptionFields(rows, 'fr', { body: { fr: 'JANAH retrouve la piste après une belle série.' } });
  assert.doesNotMatch(descriptions.longDescription, /JANAH|notre base/);
  assert.match(descriptions.longDescription, /Prix du Test|2500/);
});

test('English long fallback does not promote a French-only analysis or summary', () => {
  const h = fixture();
  for (const row of h.rows) { delete row.payload.analysis.en; delete row.payload.summary.en; }
  const result = editorialDescriptionFields(h.rows, 'en');
  assert.doesNotMatch(result.longDescription, /reste|victoires|PRIVÉ/);
  assert.match(result.longDescription, /Marseille/);
});

test('a race ordered selection cannot appear in its public long description', () => {
  const rows = [{ payload: { kind: 'horse_racing', race: { name: 'Prix du Test', racecourse: 'Longchamp',
    meetingNumber: 1, raceNumber: 5, distanceMeters: 2500, runnersCount: 16 },
    selection: { orderedNumbers: [7, 3, 2] } } }];
  const result = editorialDescriptionFields(rows, 'fr', { body: { fr: 'La combinaison 7-3-2 apparaît dans cette édition.' } });
  assert.doesNotMatch(result.longDescription, /7-3-2/);
  assert.match(result.longDescription, /Prix du Test|2500/);
});
