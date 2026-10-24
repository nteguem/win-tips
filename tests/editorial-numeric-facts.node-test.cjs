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
  ['closest pursuer with unchanged lead', '5 points d’avance sur leur premier poursuivant', 'a 5-point lead over their closest pursuer'],
  ['qualitative lower half', 'dans la seconde partie de tableau de cette Ligue 2', 'in the lower half of the table in this Ligue 2'],
  ['qualitative bottom half', 'dans la seconde partie de tableau de cette Ligue 2', 'in the bottom half of the table in this Ligue 2'],
  ['season opening match', 'pour leur premier match de la saison', 'for their season opener'],
  ['two season openings retain occurrences', 'premier match de la saison et premier match de la saison', 'season opener and season opener'],
  ['season opener keeps score and later ordinal', 'premier match de la saison : 114-106 puis 2ème match', 'season opener: 114-106 then second match'],
  ['qualitative singular leading role', 'jouer un premier rôle à l’arrivée avec 6 partants', 'play a leading role at the finish with 6 runners'],
  ['qualitative pairs keep identical multiplicity', 'un premier rôle et un premier rôle', 'a leading role and a leading role'],
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
  ['closest pursuer never removes second ordinal', '5 points devant leur second poursuivant', '5 points ahead of their closest pursuer'],
  ['closest pursuer never removes third ordinal', '5 points devant leur troisième poursuivant', '5 points ahead of their closest pursuer'],
  ['closest pursuer preserves lead count', '5 points devant leur premier poursuivant', '6 points ahead of their closest pursuer'],
  ['closest pursuer target duplicate', 'leur premier poursuivant', 'their closest pursuer and closest pursuer'],
  ['closest pursuer source duplicate', 'leur premier poursuivant et premier poursuivant', 'their closest pursuer'],
  ['closest pursuer cannot lose a separate ordinal', 'premier poursuivant, 2ème place', 'closest pursuer, 3rd place'],
  ['lower half does not remove third part', 'dans la troisième partie de tableau', 'in the lower half of the table'],
  ['lower half does not remove explicit second place', 'à la seconde place du tableau', 'in the lower half of the table'],
  ['lower half does not remove upper half rank', 'dans la première partie de tableau', 'in the lower half of the table'],
  ['lower half preserves league numeral', 'seconde partie de tableau de Ligue 2', 'lower half of the table in Ligue 1'],
  ['lower half target duplicate', 'seconde partie de tableau', 'lower half of the table and lower half of the table'],
  ['bottom half keeps actual second place', 'seconde place du tableau', 'bottom half of the table'],
  ['bottom half keeps actual third part', 'troisième partie de tableau', 'bottom half of the table'],
  ['bottom half keeps league count', 'seconde partie de tableau de Ligue 2', 'bottom half of the table in Ligue 1'],
  ['bottom and lower duplicate', 'seconde partie de tableau', 'bottom half of the table and lower half of the table'],
  ['bottom half source duplicate', 'seconde partie de tableau et seconde partie de tableau', 'bottom half of the table'],
  ['opener cannot erase second match', 'second match de la saison', 'season opener'],
  ['opener cannot erase third match', 'troisième match de la saison', 'season opener'],
  ['opener cannot replace final match', 'dernier match de la saison', 'season opener'],
  ['opener cannot erase an explicit number', '2 premiers matchs de la saison', 'season opener'],
  ['opener target duplicate', 'premier match de la saison', 'season opener and season opener'],
  ['opener source duplicate', 'premier match de la saison et premier match de la saison', 'season opener'],
  ['opener preserves other ordinal', 'premier match de la saison puis 2ème match', 'season opener then third match'],
  ['opener preserves directed score', 'premier match de la saison : 114-106', 'season opener: 106-114'],
  ['opener preserves extra count', 'premier match de la saison', 'season opener with 2 wins'],
  ['leading role is not a second role', 'jouer un second rôle', 'play a leading role'],
  ['leading role is not a third role', 'jouer un troisième rôle', 'play a leading role'],
  ['leading role is not first rank', 'occuper le premier rang', 'play a leading role'],
  ['leading role target duplicate', 'un premier rôle', 'a leading role and a leading role'],
  ['leading role source duplicate', 'un premier rôle et un premier rôle', 'a leading role'],
  ['leading role retains other rank and number', 'un premier rôle, 8ème sur 12', 'a leading role, 9th out of 12'],
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

// Exact paragraph text from the real 10:55 UTC V3 batch; no generated test
// translation is presented as native evidence. The complete seven payloads
// are separately passed through validateBatch + requireCompleteEnglish in QA.
const realGeminiParagraphs = [
  ['Petit Journal ASSE lead',
    "Les joueurs du Forez avaient seulement connu un petit coup de mou avant la trêve internationale en s'inclinant à la surprise générale du côté de Dunkerque (2-1) puis en concédant le nul à Metz (2-2). Mais les Verts ont vite repris leur marche en avant en l'emportant contre Rodez (2-0) puis du côté du Red Star (0-1) le week-end dernier. Bien installés en tête du classement, les Stéphanois disposent de 5 points d'avance sur leur premier poursuivant.",
    "The players from Forez had only experienced a slight dip in form before the international break by losing to the general surprise away at Dunkerque (2-1) then conceding a draw at Metz (2-2). But the Greens quickly resumed their forward march by winning against Rodez (2-0) then away at Red Star (0-1) last weekend. Comfortably perched at the top of the standings, the Stéphanois boast a 5-point lead over their closest pursuer."],
  ['Petit Journal Nantes lower half',
    "Si Saint-Etienne marche sur l'eau en ce début de saison, on peut clairement pas en dire autant du FC Nantes qui se retrouve englué dans la seconde partie de tableau de cette Ligue 2, quelques mois après sa relégation de l'élite, avec uns seul point d'avance sur la zone rouge. Très mal parti dans ce championnat, le club a déjà procédé à un changement d'entraineur, Grégory Poirier étant venu remplacer Michel Der Zakarian dès le mois d'août.",
    "If Saint-Etienne is flying high at the start of this season, the exact same clearly cannot be said for FC Nantes, which finds itself bogged down in the lower half of the table in this Ligue 2, a few months after being relegated from the top flight, with just a single point ahead of the drop zone. Off to a very poor start in this championship, the club has already made a managerial change, with Grégory Poirier replacing Michel Der Zakarian as early as August."],
  ['Quinte leading role',
    '6 - LE COLOMBAR – Récent vainqueur en steeple à Lyon, ce fils de Pastorius aborde ce Quinté+ avec des ambitions légitimes après avoir été supplémenté. Déjà compétitif à cette valeur et capable de s’adapter à l’état de la piste, il possède le profil pour jouer un premier rôle à l’arrivée.',
    "6 - LE COLOMBAR – A recent steeplechase winner at Lyon, this son of Pastorius approaches this Quinté+ with legitimate ambitions after being supplemented. Already competitive off this mark and capable of adapting to the track condition, he has the profile to play a leading role at the finish."],
];
for (const [label, fr, en] of realGeminiParagraphs) test('real Gemini V3 paragraph: ' + label, () => {
  assert.equal(equivalentNumericFacts(fr, en), true);
  const mutation = en.includes('5-point') ? en.replace('5-point', '6-point') : en.replace(/\b(?:2|6)\b/u, '7');
  assert.notEqual(mutation, en);
  assert.equal(equivalentNumericFacts(fr, mutation), false);
});

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
