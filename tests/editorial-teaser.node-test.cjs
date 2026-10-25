const test = require('node:test');
const assert = require('node:assert/strict');
const { contextualDescription, contextualSnippet, safeSentence } = require('../src/api/services/common/editorialTeaser');

function item(overrides = {}) {
  return { kind: 'match', teams: { home: { name: 'Marseille' }, away: { name: 'Le Havre' } },
    summary: { fr: 'Marseille reste sur 4 victoires.', en: 'Marseille have recorded 4 wins.' },
    analysis: { fr: [{ heading: 'Contexte', paragraphs: ['Marseille retrouve son public.'] }],
      en: [{ heading: 'Context', paragraphs: ['Marseille are back in front of their fans.'] }] },
    selection: { label: { fr: 'Victoire Marseille', en: 'Marseille to win' }, odds: 1.8 }, ...overrides };
}

test('contextual teaser copies the verified FR/EN team brief verbatim instead of static text', () => {
  const source = item();
  assert.equal(contextualSnippet(source, 'fr'), 'Marseille reste sur 4 victoires.');
  assert.equal(contextualSnippet(source, 'en'), 'Marseille have recorded 4 wins.');
  assert.equal(contextualDescription([{ payload: source }], 'fr'), 'Marseille — Le Havre · Marseille reste sur 4 victoires.');
  source.summary.fr = 'Marseille retrouve le Vélodrome.';
  source.summary.en = 'Marseille are back at the Vélodrome.';
  assert.equal(/4|four/.test(contextualSnippet(source, 'fr')), false);
  assert.equal(/4|four/.test(contextualSnippet(source, 'en')), false);
});

test('a VIP headline containing the exact pick is rejected before a safe analysis sentence is used', () => {
  const source = item({ summary: { fr: 'Notre angle : Victoire Marseille ce soir.', en: 'Our angle: Marseille to win tonight.' } });
  assert.equal(contextualSnippet(source, 'fr'), 'Marseille retrouve son public.');
  assert.equal(contextualSnippet(source, 'en'), 'Marseille are back in front of their fans.');
  const teaser = contextualDescription([{ payload: source }], 'en');
  assert.equal(teaser.includes('to win'), false); assert.equal(teaser.includes('1.8'), false);
});

test('direct markets and outcome promises never become public contextual copy', () => {
  const source = item();
  const markets = ['Victoire Inter', 'Win Inter', 'Inter to win', 'Inter will win the match.', 'Can Inter win tonight?',
    'Le Celtic s’impose ?', 'Le Milan AC fait un coup', 'Plus de 2,5 buts dans ce match.', 'Moins de 2,5 buts dans ce match.',
    'Over 2.5 goals in this match.', 'Under 2.5 goals in this match.', 'Double chance Marseille ou nul.',
    'Both teams to score tonight.', 'Les deux équipes marquent.', 'Le choix à une cote de 1,8.', 'The odds are 1.8 tonight.',
    'Pas de vainqueur ?', 'No winner tonight?', 'Marseille devrait gagner ce match.', 'Un pari garanti ce soir.'];
  for (const market of markets) assert.equal(safeSentence(market, source), false, market);
  assert.equal(safeSentence('Marseille reste sur 4 victoires.', source), true);
  assert.equal(safeSentence('Inter were strong at home last season.', source, 'en'), true);
  for (const forecast of ['Marseille ne perdra pas cette rencontre.', 'Marseille reste favori pour la rencontre.',
    'Marseille devrait éviter la défaite après sa série.']) assert.equal(safeSentence(forecast, source, 'fr'), false, forecast);
  assert.equal(safeSentence('Marseille should avoid defeat tonight.', source, 'en'), false);
  assert.equal(safeSentence('Marseille are likely to win tonight.', source, 'en'), false);
  for (const forecast of ['Après sa bonne série, Marseille prendra les trois points.',
    'Marseille va poursuivre sa série en battant Le Havre.']) assert.equal(safeSentence(forecast, source, 'fr'), false, forecast);
  for (const forecast of ['With their current form, Marseille will take all three points.',
    'Marseille have the form to secure all three points.']) assert.equal(safeSentence(forecast, source, 'en'), false, forecast);
  assert.equal(safeSentence('Marseille reste sur une belle série : victoire à domicile.', source, 'fr'), false);
  assert.equal(safeSentence('With their current form, home win.', source, 'en'), false);
});

test('missing or numerically inconsistent English is not replaced by French or a made-up translation', () => {
  const source = item();
  delete source.summary.en; delete source.analysis.en;
  assert.equal(contextualSnippet(source, 'en'), null); assert.equal(contextualDescription([{ payload: source }], 'en'), null);
  source.summary.en = 'Marseille have recorded 5 wins.';
  assert.equal(contextualSnippet(source, 'en'), null);
  source.analysis.en = [{ heading: 'Context', paragraphs: ['Marseille are back in front of their fans.'] }];
  assert.equal(contextualSnippet(source, 'en'), 'Marseille are back in front of their fans.');
  source.summary = { fr: 'Les deux clubs traversent une période difficile.', en: 'Les deux clubs traversent une période difficile.' };
  delete source.analysis.en;
  assert.equal(contextualSnippet(source, 'en'), null);
});

test('each excerpt is one whole bounded sentence and never contains the protected pick', () => {
  const source = item({ summary: { fr: 'Victoire Marseille.', en: 'Marseille to win.' },
    analysis: { fr: [{ paragraphs: ['Notre choix : Victoire Marseille. Marseille retrouve son public. La suite reste privée.'] }],
      en: [{ paragraphs: ['Our pick: Marseille to win. Marseille are back with their fans. Further analysis stays private.'] }] } });
  assert.equal(contextualSnippet(source, 'fr'), 'Marseille retrouve son public.');
  assert.equal(contextualSnippet(source, 'en'), 'Marseille are back with their fans.');
  source.summary.fr = 'Une phrase beaucoup trop longue '.repeat(8) + '.';
  source.analysis.fr = [{ paragraphs: ['<b>Une analyse non valide.</b>'] }];
  assert.equal(contextualSnippet(source, 'fr'), null);
  source.summary.fr = 'Marseille retrouve \u202eson public.';
  assert.equal(contextualSnippet(source, 'fr'), null);
});

test('a race teaser keeps public metadata and cannot expose picked runners through analysis fallback', () => {
  const source = item({ kind: 'horse_racing', race: { name: 'Prix du test', racecourse: 'Longchamp', meetingNumber: 1, raceNumber: 5, distanceMeters: 2500, runnersCount: 16 },
    summary: { fr: 'R1C5 · plat · 2500 m', en: 'R1C5 · flat racing · 2500 m' },
    analysis: { fr: [{ paragraphs: ['15 - JANAH reste notre favorite.'] }], en: [{ paragraphs: ['15 - JANAH is our favourite.'] }] } });
  assert.equal(contextualDescription([{ payload: source }], 'fr'), 'Prix du test · Longchamp · R1C5 · 2500 m · 16 partants');
  source.summary = { fr: 'Le numéro 7 constitue une base solide dans ce lot.', en: 'Runner number 7 is a solid banker in this field.' };
  assert.equal(contextualSnippet(source, 'fr'), 'R1C5 · 2500 m · 16 partants');
  assert.equal(contextualSnippet(source, 'en'), 'R1C5 · 2500 m · 16 runners');
  delete source.race;
  assert.equal(contextualSnippet(source, 'fr'), null); assert.equal(contextualSnippet(source, 'en'), null);
});

test('a description contains at most three source contexts and keeps whole blocks below 650 characters', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ payload: item({ teams: { home: { name: 'Home' + index }, away: { name: 'Away' + index } } }) }));
  const result = contextualDescription(rows, 'en');
  assert.equal(result.split(' • ').length, 3); assert.equal(result.includes('Home3'), false); assert.ok([...result].length <= 650);
  assert.equal(result.endsWith('Marseille have recorded 4 wins.'), true);
});

test('a combined ticket does not leak a leg selection through its public title', () => {
  const first = item(), source = item({ kind: 'combine', legs: [first], summary: { fr: 'Option : Victoire Marseille ce soir.', en: 'Angle: Marseille to win tonight.' } });
  source.selection.label = { fr: 'Notre ticket', en: 'Our ticket' };
  assert.equal(contextualSnippet(source, 'fr'), 'Marseille retrouve son public.');
  assert.equal(contextualSnippet(source, 'en'), 'Marseille are back in front of their fans.');
});

test('real archived briefs retain source context while Inter/Monaco outcome headlines are withheld', () => {
  const free = item({ summary: { fr: 'Marseille enchaîne au Vélodrome', en: 'Marseille keep the momentum going at the Vélodrome' } });
  assert.equal(contextualSnippet(free, 'fr'), 'Marseille enchaîne au Vélodrome');
  assert.equal(contextualSnippet(free, 'en'), 'Marseille keep the momentum going at the Vélodrome');
  // Bounded source excerpts remain regression fixtures, without importing the
  // local demonstration server, archived batches, users or JWT/Mongo harness.
  for (const [name, opponent, fr, en] of [
    ['Inter', 'Fiorentina', "Pour la première saison sur le banc de Christian Chivu, l'Inter a été intraitable sur la scène nationale l'an passé.",
      "For Christian Chivu's first season on the bench, Inter were untamable on the domestic stage last year."],
    ['Monaco', 'Lille', "Monaco connaît un coup d'arrêt en Championnat après avoir brillé en début de saison.",
      'Monaco are experiencing a halt in momentum in the Championship after shining at the start of the season.'],
  ]) {
    const source = item({ teams: { home: { name }, away: { name: opponent } }, summary: { fr: 'Victoire ' + name, en: name + ' to win' },
      selection: { label: { fr: 'Victoire ' + name, en: name + ' to win' } },
      analysis: { fr: [{ paragraphs: [fr] }], en: [{ paragraphs: [en] }] } });
    for (const lang of ['fr', 'en']) {
      const teaser = contextualSnippet(source, lang);
      assert.ok(teaser, name); assert.notEqual(teaser, source.summary[lang]);
      assert.equal(teaser.includes(source.selection.label[lang]), false);
    }
  }
});

test('the public teaser skips derogatory commentary and chooses a neutral source sentence naming a team', () => {
  const source = item({ teams: { home: { name: 'Cleveland Cavaliers' }, away: { name: 'Brooklyn Nets' } },
    summary: { fr: 'Cleveland Cavaliers — Brooklyn Nets', en: 'Cleveland Cavaliers — Brooklyn Nets' },
    analysis: { fr: [{ paragraphs: ['Les prestations ignobles de Cleveland la saison dernière.',
      'Pour commencer la saison, les Nets ont laissé les Hornets leur voler la vedette au Barclays Center (défaite 103-110).'] }],
    en: [{ paragraphs: ['The atrocious performances of Cleveland last season.',
      'To start the season, the Nets let the Hornets steal the show at the Barclays Center (a 103-110 defeat).'] }] } });
  assert.equal(contextualSnippet(source, 'fr'), 'Pour commencer la saison, les Nets ont laissé les Hornets leur voler la vedette au Barclays Center (défaite 103-110).');
  assert.equal(contextualSnippet(source, 'en'), 'To start the season, the Nets let the Hornets steal the show at the Barclays Center (a 103-110 defeat).');
  assert.match(source.analysis.fr[0].paragraphs[0], /ignobles/u);
  assert.match(source.analysis.en[0].paragraphs[0], /atrocious/u);
});
