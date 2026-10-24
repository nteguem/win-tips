'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { equivalentNumericFacts } = require('../src/api/services/common/editorialNumericFacts');
const { hasCompleteEnglish } = require('../src/api/services/common/editorialValidation');

const equivalent = [
  ['decimal odds', 'Cote 1,50', 'Odds 1.50'],
  ['decimal percentage', '4 tirs sur 36 (11,1 %)', '4 shots out of 36 (11.1%)'],
  ['thousands, distance and clock', '2 850 mètres, 235 000 euros, 20h15', '2,850 metres, 235,000 euros, 20:15'],
  ['narrow-space thousands', '235\u202f000 euros', '235,000 euros'],
  ['cardinal words', '5 nuls puis 4 matchs et 0 défaite', 'five draws then four matches and zero defeats'],
  ['one statistical point', '1 point', 'one point'],
  ['one explicit small point', 'un seul petit point', 'one point'],
  ['one season with pronoun left alone', 'une seule saison, une équipe en 2026', 'one season, a team in 2026'],
  ['cardinals in both languages', 'Dix-huit partants et trois victoires', 'Eighteen runners and three victories'],
  ['ordinal words', '2ème titre, 4e quart-temps, 7ème revers', 'second title, fourth quarter, seventh defeat'],
  ['ordinal digit suffixes', '12ème et 14èmes', '12th and 14th'],
  ['plural ordinal interval', 'les 4 premières journées', 'the first four matchdays'],
  ['word ordinal interval', 'les quatre premières journées', 'the first four matchdays'],
  ['competition name', 'Premier League, 3 victoires', 'Premier League, three wins'],
  ['leading-role idiom', 'jouer les premiers rôles avec 7 partants', 'play leading roles with 7 runners'],
  ['qualitative early performances', 'les premières performances du FCK après 6 journées', 'the early performances of FCK after 6 matchdays'],
  ['qualitative initial performances', 'les premières performances du FCK', 'the initial performances of FCK'],
  ['numbered early performances preserve count', 'les 2 premières performances', 'the 2 early performances'],
  ['two losses as twice', 'perdre à 2 reprises', 'losing twice'],
  ['two written losses as twice', 'perdre à deux reprises', 'losing twice'],
  ['real consecutive loss group', 'avant de perdre à 2 reprises, face à Fribourg (2-1) et à Mayence (0-1)', 'before losing twice, against Fribourg (2-1) and Mayence (0-1)'],
  ['first-team term', 'équipe première et 2 victoires', 'first team and two wins'],
  ['first place outside the zone remains an ordinal', 'le premier non-relégable avec 3 points', 'the first team outside the relegation zone with three points'],
  ['explicit both-market', 'Les 2 marquent', 'Both teams to score — Yes'],
  ['explicit two-sided phrase', 'des buts des deux côtés', 'goals by both sides'],
  ['explicit repeated loss count', '6 journées et autant de défaites', '6 matchdays and 6 defeats'],
  ['relative repeated loss count in both languages', '6 journées et autant de défaites', '6 matchdays and as many defeats'],
  ['relative repeated loss count comma', '6 journées et autant de défaites', '6 matchdays, 6 defeats'],
  ['three-point shot unit', '4 tirs primés sur 36 (11,1 %)', '4 three-pointers out of 36 (11.1%)'],
  ['signed deficit and score', '3 points de retard, défaite 128-116', 'three points behind, defeat 128-116'],
  ['score separator notation', 'victoire 3–2 puis défaite 0−1', 'win 3-2 then defeat 0-1'],
];
for (const [label, fr, en] of equivalent) test('numeric equivalence: ' + label, () => assert.equal(equivalentNumericFacts(fr, en), true));

const changed = [
  ['odds', 'Cote 1,50', 'Odds 150'],
  ['decimal odds digit', 'Cote 1,50', 'Odds 1.51'],
  ['amount', '235 000 euros', '235,001 euros'],
  ['distance', '2 850 mètres', '2,800 metres'],
  ['percentage value', '11,1 %', '111%'],
  ['percentage unit removed', '11,1 %', '11.1'],
  ['score reversed', 'victoire 3-2', 'win 2-3'],
  ['score digit', 'victoire 3-2', 'win 3-1'],
  ['clock', '20h15', '20:51'],
  ['ordinal changed', '4e quart-temps', 'fifth quarter'],
  ['ordinal unit removed', '4e quart-temps', '4 quarters'],
  ['cardinal changed', '5 nuls', 'six draws'],
  ['repeat added', '3 points', '3 points and three goals'],
  ['relative defeat changed', '6 journées et autant de défaites', '6 matchdays and 7 defeats'],
  ['unrelated repetition added', '6 journées et autant de défaites', '6 matchdays, 6 defeats and 6 points'],
  ['both repeated', 'Les 2 marquent', 'Both teams to score and both teams win'],
  ['unrelated both is not a numeral', 'Les 2 marquent', 'Both managers win'],
  ['wrong shot unit', '4 tirs primés sur 36', '4 two-pointers out of 36'],
  ['one is still a quantity', '1 point', 'two points'],
  ['one repeated point', 'un point', 'one point and one point'],
  ['large integer precision', '9007199254740992 points', '9007199254740993 points'],
  ['decimal precision', 'Cote 1,500000000000000001', 'Odds 1.500000000000000002'],
  ['relative loss outcome cannot become draws', '6 journées et autant de défaites', '6 matchdays and 6 draws'],
  ['early form never removes a rank', 'la première place', 'early performances'],
  ['early form never removes a count', 'les 2 premières performances', 'early performances'],
  ['early form is not second performance', 'les premières performances', 'the second performances'],
  ['early form is not third performance', 'les premières performances', 'the third performances'],
  ['early form duplicate', 'les premières performances', 'early performances and initial performances'],
  ['one loss is not twice', 'perdre à 1 reprise', 'losing twice'],
  ['three losses are not twice', 'perdre à 3 reprises', 'losing twice'],
  ['losses cannot become wins twice', 'perdre à 2 reprises', 'winning twice'],
  ['wins are not a loss count', 'gagner à 2 reprises', 'losing twice'],
  ['goal count does not license twice', '2 buts', 'losing twice'],
  ['goal count does not license extra twice', '2 buts', '2 goals and losing twice'],
  ['two losses are not once', 'perdre à 2 reprises', 'losing once'],
  ['two losses are not three times', 'perdre à 2 reprises', 'losing three times'],
  ['twice duplicate', 'perdre à 2 reprises', 'losing twice twice'],
  ['twice and another occurrence', 'perdre à 2 reprises', 'losing twice and once more'],
  ['twice then another occurrence', 'perdre à 2 reprises', 'losing twice, and once more'],
  ['twice does not lose positive polarity', 'avant de perdre à 2 reprises', 'before not losing twice'],
  ['negated loss does not license twice', 'avant de ne pas perdre à 2 reprises', 'before losing twice'],
  ['denied loss does not license twice', 'perdre à 2 reprises', 'they denied losing twice'],
  ['twice wrong directed score', 'avant de perdre à 2 reprises, face à Fribourg (2-1)', 'before losing twice, against Fribourg (1-2)'],
];
for (const [label, fr, en] of changed) test('numeric mutation refused: ' + label, () => assert.equal(equivalentNumericFacts(fr, en), false));

function translatedItem() {
  return { title: { fr: 'Match', en: 'Match' }, summary: { fr: '5 nuls', en: 'five draws' },
    selection: { label: { fr: 'Cote 1,50', en: 'Odds 1.50' } },
    analysis: { fr: [{ heading: '4e journée', paragraphs: ['3 points, 11,1 %'] }],
      en: [{ heading: 'fourth matchday', paragraphs: ['three points, 11.1%'] }] } };
}
test('complete English retains section, paragraph and leg requirements', () => {
  const item = translatedItem();
  assert.equal(hasCompleteEnglish(item), true);
  item.legs = [translatedItem()]; assert.equal(hasCompleteEnglish(item), true);
  delete item.legs[0].selection.label.en; assert.equal(hasCompleteEnglish(item), false);
  delete item.legs; item.analysis.en[0].paragraphs = []; assert.equal(hasCompleteEnglish(item), false);
  item.analysis.en = []; assert.equal(hasCompleteEnglish(item), false);
});
test('complete English still refuses missing and changed quantities', () => {
  const item = translatedItem();
  item.analysis.en[0].paragraphs[0] = 'four points, 11.1%'; assert.equal(hasCompleteEnglish(item), false);
  item.analysis.en[0].paragraphs[0] = ''; assert.equal(hasCompleteEnglish(item), false);
  delete item.summary.en; assert.equal(hasCompleteEnglish(item), false);
});
