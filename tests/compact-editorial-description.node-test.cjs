'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactEditorialDescription: compact } = require('../src/api/services/common/compactEditorialDescription');
const { VERSION, V2_VERSION } = require('../src/api/services/common/editorialCopy');

const item = (overrides = {}) => ({ kind: 'match', sourceId: '101',
  teams: { home: { name: 'Marseille' }, away: { name: 'Le Havre' } },
  summary: { fr: 'Marseille reste sur 4 victoires.', en: 'Marseille have recorded 4 wins.' },
  analysis: { fr: [{ paragraphs: ['Marseille retrouve son public.'] }], en: [{ paragraphs: ['Marseille are back with their fans.'] }] },
  selection: { label: { fr: 'Victoire Marseille', en: 'Marseille to win' }, odds: 1.85 }, ...overrides });
const rows = items => items.map(payload => ({ sourceId: payload.sourceId, payload }));
const copy = (entry = {}, overrides = {}) => ({ version: V2_VERSION,
  choice: { entries: [{ id: '101', notification: { fr: 'Marseille reste sur 4 victoires.', en: 'Marseille have recorded 4 wins.' }, ...entry }] },
  body: { fr: 'Un corps long. '.repeat(60), en: 'A long body. '.repeat(60) }, ...overrides });
function bounded(value) {
  assert.equal(typeof value, 'string');
  assert.ok([...value].length <= 140, `${[...value].length} code points`);
  assert.doesNotMatch(value, /\.\.\.|…/u);
}

test('ten matches use one complete first hook and never concatenate the remaining contexts', () => {
  const first = item();
  const later = Array.from({ length: 9 }, (_, index) => item({ sourceId: String(index + 102),
    teams: { home: { name: 'Later' + index }, away: { name: 'Opponent' + index } } }));
  const sourceRows = rows([first, ...later]);
  const description = compact(sourceRows, 'fr', copy());
  assert.equal(description, 'Marseille — Le Havre · Marseille reste sur 4 victoires.');
  assert.equal(description, compact(rows([first]), 'fr', copy()));
  assert.doesNotMatch(description, /Later|Opponent|Un corps long/);
  bounded(description);
});

test('French and English select their own whole hooks with no French fallback in English', () => {
  assert.equal(compact(rows([item()]), 'en', copy()), 'Marseille — Le Havre · Marseille have recorded 4 wins.');
  const source = item({ summary: { fr: 'Marseille retrouve son public.' }, analysis: {} });
  const sourceCopy = copy({ notification: { fr: 'Marseille retrouve son public.' } });
  const english = compact(rows([source]), 'en', sourceCopy);
  assert.equal(english, 'Marseille — Le Havre');
  assert.doesNotMatch(english, /retrouve|public/);
});

test('a safe short V2 notification is preferred over its long description and body', () => {
  const value = compact(rows([item()]), 'fr', copy({ description: { fr: 'Longue description '.repeat(9), en: 'Long description '.repeat(9) } }));
  assert.equal(value, 'Marseille — Le Havre · Marseille reste sur 4 victoires.');
  bounded(value);
});

test('a hook whose teams have exceptionally long names is returned whole instead of cutting the names', () => {
  const source = item({ teams: { home: { name: 'Club avec un très long nom officiel '.repeat(4) }, away: { name: 'Autre nom officiel '.repeat(4) } } });
  const value = compact(rows([source]), 'fr', copy());
  assert.equal(value, 'Marseille reste sur 4 victoires.');
  bounded(value);
});

test('the budget counts Unicode code points rather than UTF-16 units or UTF-8 bytes', () => {
  const hook = 'Marseille retrouve son public ' + '😀'.repeat(45) + '.';
  const source = item({ teams: { home: { name: 'Marseille ' + '😀'.repeat(20) }, away: { name: 'Le Havre' } } });
  const value = compact(rows([source]), 'fr', copy({ notification: { fr: hook, en: 'Marseille are back with their fans.' } }));
  assert.equal(value, `${source.teams.home.name} — Le Havre · ${hook}`);
  assert.ok(value.length > 140);
  bounded(value);
});

test('an overlong complete source sentence is rejected without truncation and factual labels remain whole', () => {
  const source = item({ summary: { fr: 'Marseille retrouve son public dans un stade ' + 'très animé '.repeat(9) + '.', en: '' }, analysis: {} });
  const value = compact(rows([source]), 'fr');
  assert.equal(value, 'Marseille — Le Havre');
  bounded(value);
});

test('selection-bearing V2 hooks, summaries and analysis sentences never become the public description', () => {
  const source = item({ summary: { fr: 'Notre choix : Victoire Marseille.', en: 'Our pick: Marseille to win.' },
    analysis: { fr: [{ paragraphs: ['Marseille devrait gagner à une cote de 1,85.'] }], en: [{ paragraphs: ['Marseille should win at odds 1.85.'] }] } });
  const sourceCopy = copy({ notification: { fr: 'Victoire Marseille à une cote de 1,85.', en: 'Marseille to win at odds 1.85.' } });
  for (const language of ['fr', 'en']) {
    const value = compact(rows([source]), language, sourceCopy);
    assert.equal(value, 'Marseille — Le Havre');
    assert.doesNotMatch(value, /Victoire|to win|1[,.]85/);
  }
});

test('mismatched English numeric facts fall back to the screened source snippet', () => {
  const value = compact(rows([item()]), 'en', copy({ notification: { fr: 'Marseille reste sur 4 victoires.', en: 'Marseille have recorded 7 wins.' } }));
  assert.match(value, /4 wins/);
  assert.doesNotMatch(value, /7 wins/);
});

test('a combined coupon uses only its first leg and never its prediction-bearing title', () => {
  const source = { kind: 'combine', sourceId: '101', title: 'Victoire Marseille et deux équipes marquent',
    legs: [item(), item({ teams: { home: { name: 'Later Club' }, away: { name: 'Other Club' } } })],
    summary: { fr: 'Notre choix : victoire Marseille.' }, selection: { label: { fr: 'Victoire Marseille' } } };
  const value = compact(rows([source]), 'fr', copy());
  assert.equal(value, 'Marseille — Le Havre · Marseille reste sur 4 victoires.');
  assert.doesNotMatch(value, /Later Club|Other Club|Victoire|marquent/);
});

test('horse racing uses public race metadata and never any generated or archived horse selection', () => {
  const source = { kind: 'horse_racing', sourceId: '101', race: { name: 'Prix du Test', racecourse: 'Longchamp',
    meetingNumber: 1, raceNumber: 5, distanceMeters: 2500, runnersCount: 16 },
    summary: { fr: 'JANAH reste sur 4 victoires.', en: 'JANAH have recorded 4 wins.' },
    analysis: { fr: [{ paragraphs: ['JANAH reste notre sélection.'] }], en: [{ paragraphs: ['JANAH is our pick.'] }] },
    selection: { runners: ['JANAH'] } };
  const sourceCopy = copy({ notification: { fr: 'JANAH reste sur 4 victoires.', en: 'JANAH have recorded 4 wins.' } });
  assert.equal(compact(rows([source]), 'fr', sourceCopy), 'Prix du Test · Longchamp · R1C5 · 2500 m · 16 partants');
  assert.equal(compact(rows([source]), 'en', sourceCopy), 'Prix du Test · Longchamp · R1C5 · 2500 m · 16 runners');
  for (const language of ['fr', 'en']) assert.doesNotMatch(compact(rows([source]), language, sourceCopy), /JANAH/);
});

test('a huge race name falls back to complete metadata instead of a cut race name', () => {
  const source = { kind: 'horse_racing', race: { name: 'Nom officiel de la course '.repeat(10), racecourse: 'Longchamp',
    meetingNumber: 1, raceNumber: 5, distanceMeters: 2500, runnersCount: 16 } };
  const value = compact(rows([source]), 'fr');
  assert.equal(value, 'R1C5 · 2500 m · 16 partants');
  bounded(value);
});

test('one whole short V1 archive block is preserved while other matches remain outside the card', () => {
  const source = item({ summary: {}, analysis: {} });
  const archive = { version: VERSION, body: { fr: 'Marseille — Le Havre : quel visage pour ce duel ? • ' + 'Une autre rencontre complète. '.repeat(8),
    en: 'Marseille — Le Havre: how will this matchup unfold? • ' + 'Another complete matchup. '.repeat(8) } };
  assert.equal(compact(rows([source]), 'fr', archive), 'Marseille — Le Havre : quel visage pour ce duel ?');
  assert.equal(compact(rows([source]), 'en', archive), 'Marseille — Le Havre: how will this matchup unfold?');
});

test('a historical validated V1 body that is already short retains its exact compatible rendering', () => {
  const source = item({ summary: {}, analysis: {} });
  const archive = { version: VERSION, body: { fr: 'Alpha — Bravo : quel visage pour ce duel ? • Charlie — Delta : quels enjeux ?',
    en: 'Alpha — Bravo: how will this matchup unfold? • Charlie — Delta: what is at stake?' } };
  for (const language of ['fr', 'en']) assert.equal(compact(rows([source]), language, archive), archive.body[language]);
});

test('byte-clamped or overlong archive blocks fall back to public labels without an ellipsis', () => {
  const source = item({ summary: {}, analysis: {} });
  for (const body of ['Marseille — Le Havre : une analyse…', 'Marseille — Le Havre : une analyse...', 'Un bloc long '.repeat(20)]) {
    const value = compact(rows([source]), 'fr', { version: VERSION, body: { fr: body } });
    assert.equal(value, 'Marseille — Le Havre');
    bounded(value);
  }
});

test('V2 copy entry order is matched to its own event rather than an unrelated match', () => {
  const later = item({ sourceId: '102', teams: { home: { name: 'Paris' }, away: { name: 'Lyon' } } });
  const value = compact(rows([later, item()]), 'fr', copy());
  assert.equal(value, 'Marseille — Le Havre · Marseille reste sur 4 victoires.');
});

test('no matching V2 source ID means the copy is not used for another event', () => {
  const value = compact(rows([item()]), 'fr', copy({ id: 'unknown', notification: { fr: 'Paris reste sur 7 victoires.', en: 'Paris have recorded 7 wins.' } }));
  assert.equal(value, 'Marseille — Le Havre · Marseille reste sur 4 victoires.');
  assert.doesNotMatch(value, /Paris|7/);
});

test('very long names, malformed rows and empty input have bounded whole factual fallbacks', () => {
  const long = item({ teams: { home: { name: 'Long Home Name '.repeat(20) }, away: { name: 'Long Away Name '.repeat(20) } }, summary: {}, analysis: {} });
  assert.equal(compact(rows([long]), 'fr'), 'Les rencontres et analyses de cette édition.');
  assert.equal(compact(rows([{ kind: 'match', title: 'Victoire Inter', summary: {}, analysis: {} }]), 'en'), 'The matches and analysis in this edition.');
  assert.equal(compact([], 'fr'), null);
  assert.equal(compact([], 'fr', null, { fallback: 'Le programme de cette édition.' }), 'Le programme de cette édition.');
});

test('compact presentation leaves full reader content and cached editorial copy unchanged', () => {
  const sourceRows = rows([item(), item({ sourceId: '102' })]), sourceCopy = copy();
  const before = JSON.stringify({ sourceRows, sourceCopy });
  const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } };
  freeze(sourceRows); freeze(sourceCopy);
  for (const language of ['fr', 'en']) bounded(compact(sourceRows, language, sourceCopy));
  assert.equal(JSON.stringify({ sourceRows, sourceCopy }), before);
});
