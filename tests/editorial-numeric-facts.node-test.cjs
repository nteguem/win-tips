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
  ['opening match interval count before first', 'six premiers matchs de championnats', 'six first league matches'],
  ['opening match interval first before count', 'six premiers matchs de championnats', 'first six league matches'],
  ['opening match interval numeral count', 'les 6 premiers matchs', 'the 6 first games'],
  ['opening fixture interval keeps quantity', 'les quatre premières rencontres', 'the first four fixtures'],
  ['opening matchday interval reverse order', 'les quatre premières journées', 'the four first matchdays'],
  ['opening intervals preserve multiplicity', '6 premiers matchs et 4 premières journées', 'six first league matches and first four matchdays'],
  ['opening interval retains a separate first rank', '6 premiers matchs puis première place', 'first six league matches then first place'],
  ['top N ranking retains N', 'terminer dans les cinq premiers du Quinté+', 'finish in the top five of the Quinté+'],
  ['top N numeric ranking retains N', 'parmi les 5 premiers, 7ème départ', 'among the top five, seventh start'],
  ['points deficit to safety keeps the explicit count', 'à 5 longueurs du premier non-relégable', '5 points adrift of safety'],
  ['written points deficit to safety keeps the explicit count', 'à cinq points du premier non relégable', 'five points adrift of safety'],
  ['safety deficit retains another rank', 'à 5 longueurs du premier non-relégable, 20ème place', '5 points adrift of safety, 20th place'],
  ['qualitative aim at leading places is not first place', 'viser les premières places', 'in pursuit of the leading places'],
  ['nominal top group keeps its quantity', 'les six premiers du classement', 'the top six of the standings'],
  ['nominal top group accepts numeric quantity', 'les 6 premiers du classement', 'the top six of the standings'],
  ['nominal top group retains another rank', 'les six premiers du classement, 11ème rang', 'the top six of the standings, 11th place'],
  ['conceded first goal is the opening goal', "punis d'avoir encaissé le premier but", 'punished for conceding the opening goal'],
  ['shirt debut retains person and shirt', 'pour la première de Dani Carvajal sous le maillot azulon', "for Dani Carvajal's debut in the azulon shirt"],
  ['shirt debut retains Unicode person and apostrophe', 'Pour la première de Ángel Correa sous le maillot rouge', 'For Ángel Correa’s debut in the rouge shirt'],
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
  ['opening interval changed count', 'six premiers matchs', 'five first league matches'],
  ['opening interval changed numeric count', '6 premiers matchs', 'first 5 league matches'],
  ['opening interval changed ordinal', 'six premiers matchs', 'six second league matches'],
  ['opening interval explicit ordinal changed', 'six premiers matchs', 'six 2nd league matches'],
  ['opening interval duplicate target', 'six premiers matchs', 'six first league matches and first six league matches'],
  ['opening interval duplicate source', 'six premiers matchs et six premiers matchs', 'six first league matches'],
  ['opening interval unrelated first place finishes', 'six premiers matchs', 'six first place finishes'],
  ['opening interval hyphenated first-place finishes', 'six premiers matchs', 'six first-place finishes'],
  ['opening interval first before counted places', 'six premiers matchs', 'first six place finishes'],
  ['opening interval cannot erase real first place', 'six premiers matchs, 1ère place', 'six first league matches'],
  ['opening interval cannot change another rank', 'six premiers matchs puis 4ème rang', 'first six league matches then fifth place'],
  ['opening interval cannot change chapter rank', 'chapitre premier, six premiers matchs', 'chapter second, first six league matches'],
  ['opening interval does not authorize an extra number', 'six premiers matchs', 'six first league matches and 3 goals'],
  ['opening interval does not reverse directed score', 'six premiers matchs (3-1)', 'six first league matches (1-3)'],
  ['opening interval cannot change event unit', 'six premières journées', 'six first league matches'],
  ['opening interval cannot invent an interval without source', 'six matchs', 'first six league matches'],
  ['top N ranking wrong count', 'dans les cinq premiers', 'in the top four'],
  ['top N ranking does not erase a separate first rank', 'dans les cinq premiers, première place', 'in the top five'],
  ['top N ranking does not license a first-place claim', 'dans les cinq premiers', 'five first-place finishes'],
  ['top N ranking preserves other count', 'dans les cinq premiers après 12 sorties', 'in the top five after 13 outings'],
  ['safety deficit wrong count', 'à 5 longueurs du premier non-relégable', '4 points adrift of safety'],
  ['safety deficit wrong unit', 'à 5 longueurs du premier non-relégable', '5 goals adrift of safety'],
  ['safety deficit wrong direction', 'à 5 longueurs du premier non-relégable', '5 points clear of safety'],
  ['safety deficit cannot replace a second rank', 'à 5 longueurs du deuxième non-relégable', '5 points adrift of safety'],
  ['safety deficit target duplicate', 'à 5 longueurs du premier non-relégable', '5 points adrift of safety and 5 points adrift of safety'],
  ['safety deficit source duplicate', 'à 5 longueurs du premier non-relégable, à 5 longueurs du premier non-relégable', '5 points adrift of safety'],
  ['safety deficit retains a separate first rank', 'à 5 longueurs du premier non-relégable et première place', '5 points adrift of safety'],
  ['safety deficit retains other quantities', 'à 5 longueurs du premier non-relégable avec 2 points', '5 points adrift of safety with 3 points'],
  ['safety deficit cannot move another quantity into the relation', 'à 5 longueurs du premier non-relégable avec 2 points', '2 points adrift of safety with 5 points'],
  ['safety deficit retains directed score', 'à 5 longueurs du premier non-relégable (1-3)', '5 points adrift of safety (3-1)'],
  ['safety deficit explicitly negated target', 'à 5 longueurs du premier non-relégable', 'not 5 points adrift of safety'],
  ['safety deficit explicitly negated source', 'pas à 5 longueurs du premier non-relégable', '5 points adrift of safety'],
  ['safety deficit negated target qualifier', 'à 5 longueurs du premier non-relégable', 'not exactly 5 points adrift of safety'],
  ['safety deficit negated source qualifier', 'pas exactement à 5 longueurs du premier non-relégable', '5 points adrift of safety'],
  ['safety deficit source negation cannot be displaced', "n'est à 5 longueurs du premier non-relégable", '5 points adrift of safety'],
  ['safety deficit target negation after relation', 'à 5 longueurs du premier non-relégable', '5 points adrift of safety is not the case'],
  ['safety deficit signed quantity cannot swap with unsigned relation', 'à 5 longueurs du premier non-relégable avec -5 points', '-5 points adrift of safety with 5 points'],
  ['safety deficit Unicode signed quantity cannot swap', 'à 5 longueurs du premier non-relégable avec -5 points', '−5 points adrift of safety with 5 points'],
  ['safety deficit separated sign cannot swap', 'à 5 longueurs du premier non-relégable avec -5 points', '- 5 points adrift of safety with 5 points'],
  ['safety deficit signed word cannot qualify relation', 'à 5 longueurs du premier non-relégable', 'negative 5 points adrift of safety'],
  ['safety deficit decimal suffix cannot become deficit', 'à 5 longueurs du premier non-relégable avec 1.5 points', '1.5 points adrift of safety with 5 points'],
  ['leading places cannot invent a qualitative source', 'viser la deuxième place', 'in pursuit of the leading places'],
  ['leading places cannot become first place', 'viser les premières places', 'in pursuit of first place'],
  ['leading places target duplicate', 'viser les premières places', 'in pursuit of the leading places and in pursuit of the leading places'],
  ['leading places source duplicate', 'viser les premières places puis viser les premières places', 'in pursuit of the leading places'],
  ['leading places retain a separate first rank', 'viser les premières places après une première place', 'in pursuit of the leading places'],
  ['leading places retain handicap value', '37 pour viser les premières places', '38 in pursuit of the leading places'],
  ['leading places target local negation', '37 pour viser les premières places', '37 not in pursuit of the leading places'],
  ['leading places source local negation', '37 pour ne pas viser les premières places', '37 in pursuit of the leading places'],
  ['leading places target contracted negation', '37 pour viser les premières places', "37 isn't in pursuit of the leading places"],
  ['leading places target curved contracted negation', '37 pour viser les premières places', '37 isn’t in pursuit of the leading places'],
  ['leading places source contracted negation', "37 n'envisage viser les premières places", '37 in pursuit of the leading places'],
  ['leading places target negation after relation', '37 pour viser les premières places', '37 in pursuit of the leading places is not the aim'],
  ['nominal top group changes count', 'les six premiers du classement', 'the top five of the standings'],
  ['nominal top group wrong ordinal', 'les six deuxièmes du classement', 'the top six of the standings'],
  ['nominal top group target duplicate', 'les six premiers du classement', 'the top six of the standings and the top six of the standings'],
  ['nominal top group source duplicate', 'les six premiers du classement et les six premiers du classement', 'the top six of the standings'],
  ['nominal top group target negation', 'les six premiers du classement', 'not the top six of the standings'],
  ['nominal top group source negation', 'pas les six premiers du classement', 'the top six of the standings'],
  ['nominal top group signed count cannot swap', 'les six premiers du classement avec -6 points', 'the top -6 of the standings with 6 points'],
  ['nominal top group retains extra ordinal', 'les six premiers du classement, première place', 'the top six of the standings'],
  ['nominal top group retains other quantity', 'les six premiers du classement avec 4 points', 'the top six of the standings with 5 points'],
  ['conceded first goal cannot become second goal', "punis d'avoir encaissé le premier but", 'punished for conceding the second goal'],
  ['conceded first goal source negation', "pas punis d'avoir encaissé le premier but", 'punished for conceding the opening goal'],
  ['conceded first goal target negation', "punis d'avoir encaissé le premier but", 'not punished for conceding the opening goal'],
  ['conceded first goal target contraction', "punis d'avoir encaissé le premier but", "weren't punished for conceding the opening goal"],
  ['conceded first goal target duplicate', "punis d'avoir encaissé le premier but", 'punished for conceding the opening goal and punished for conceding the opening goal'],
  ['conceded first goal retains another first rank', "punis d'avoir encaissé le premier but, première place", 'punished for conceding the opening goal'],
  ['conceded first goal retains score direction', "punis d'avoir encaissé le premier but (2-4)", 'punished for conceding the opening goal (4-2)'],
  ['shirt debut wrong person', 'pour la première de Dani Carvajal sous le maillot azulon', "for Dani Alonso's debut in the azulon shirt"],
  ['shirt debut wrong shirt', 'pour la première de Dani Carvajal sous le maillot azulon', "for Dani Carvajal's debut in the rouge shirt"],
  ['shirt debut target negation', 'pour la première de Dani Carvajal sous le maillot azulon', "not for Dani Carvajal's debut in the azulon shirt"],
  ['shirt debut source negation', 'pas pour la première de Dani Carvajal sous le maillot azulon', "for Dani Carvajal's debut in the azulon shirt"],
  ['shirt debut target duplicate', 'pour la première de Dani Carvajal sous le maillot azulon', "for Dani Carvajal's debut in the azulon shirt and for Dani Carvajal's debut in the azulon shirt"],
  ['shirt debut source duplicate', 'pour la première de Dani Carvajal sous le maillot azulon et pour la première de Dani Carvajal sous le maillot azulon', "for Dani Carvajal's debut in the azulon shirt"],
  ['shirt debut retains another ordinal', 'pour la première de Dani Carvajal sous le maillot azulon, première place', "for Dani Carvajal's debut in the azulon shirt"],
  ['shirt debut retains score direction', 'pour la première de Dani Carvajal sous le maillot azulon (2-5)', "for Dani Carvajal's debut in the azulon shirt (5-2)"],
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
test('exact native V6 Le Havre deficit to safety preserves all other facts', () => {
  const fr = "Seule équipe de Ligue 1 à ne pas avoir encore gagné, Le Havre ferme la marche au classement avec 2 points, à 5 longueurs du premier non-relégable. Les Ciel et Marine ont alimenté leur compteur pour la dernière fois le 12 septembre, face à Angers (0-0). Ils ont depuis été battus par Toulouse (3-2), Lille (1-0) puis Auxerre (1-3), en concédant toujours l'ouverture du score. Le club normand est à la peine dans le secteur offensif : aucune équipe n'a moins marqué que lui en 7 matchs (5 buts). Avantage Marseille au niveau de la forme";
  const en = "As the only Ligue 1 team yet to win a match, Le Havre bring up the rear in the standings with 2 points, 5 points adrift of safety. The Ciel et Marine added to their points tally for the last time on 12 September against Angers (0-0). They have since been beaten by Toulouse (3-2), Lille (1-0) and Auxerre (1-3), conceding the opening goal on each occasion. The Norman club are struggling in attack: no team has scored fewer goals than them in 7 matches (5 goals). Form edge to Marseille";
  assert.equal(equivalentNumericFacts(fr, en), true);
  for (const mutation of [en.replace('5 points adrift', '4 points adrift'), en.replace('5 points adrift', '5 goals adrift'),
    en.replace('5 points adrift', '5 points clear'), en.replace('(1-3)', '(3-1)'), en.replace('12 September', '13 September'), en.replace('7 matches', '8 matches')]) {
    assert.notEqual(mutation, en);
    assert.equal(equivalentNumericFacts(fr, mutation), false);
  }
});

test('exact native V6 Cristabel qualitative leading places preserves rank and handicap', () => {
  const fr = "8 - CRISTABEL – Déjà troisième d’un Quinté+ en juillet après une belle fin de course, elle a confirmé sa compétitivité lors de ses sorties suivantes, notamment dans une Classe 2 à Craon. Sa valeur handicap de 37 semble lui laisser une belle carte à jouer à Saint-Cloud pour viser les premières places.";
  const en = "8 - CRISTABEL – Already third in a Quinté+ in July following a strong finish, she confirmed her competitiveness in her subsequent outings, notably in a Class 2 event at Craon. Her handicap mark of 37 appears to give her a strong hand to play at Saint-Cloud in pursuit of the leading places.";
  assert.equal(equivalentNumericFacts(fr, en), true);
  for (const mutation of [en.replace('third', 'second'), en.replace('37', '38'), en.replace('8 -', '9 -'),
    en.replace('Class 2', 'Class 3'), en.replace('the leading places', 'first place')]) {
    assert.notEqual(mutation, en);
    assert.equal(equivalentNumericFacts(fr, mutation), false);
  }
});

test('native Cristabel bid for the leading places keeps the qualitative aim and every numerical fact', () => {
  const fr = "8 - CRISTABEL – Déjà troisième d’un Quinté+ en juillet après une belle fin de course, elle a confirmé sa compétitivité lors de ses sorties suivantes, notamment dans une Classe 2 à Craon. Sa valeur handicap de 37 semble lui laisser une belle carte à jouer à Saint-Cloud pour viser les premières places.";
  const en = "8 - CRISTABEL – Already third in a Quinté+ in July following a strong finish, she confirmed her competitiveness in her subsequent outings, notably in a Class 2 event at Craon. Her handicap rating of 37 looks to give her a strong hand to play at Saint-Cloud in her bid for the leading places.";
  assert.equal(equivalentNumericFacts(fr, en), true);
  for (const mutation of [en.replace('third', 'second'), en.replace('Class 2', 'Class 3'),
    en.replace('37', '38'), en.replace('8 -', '9 -'), en.replace('the leading places', 'first place'),
    en.replace('in her bid', 'not in her bid'), en + ' In her bid for the leading places.']) {
    assert.notEqual(mutation, en);
    assert.equal(equivalentNumericFacts(fr, mutation), false);
  }
  assert.equal(equivalentNumericFacts(fr.replace('pour viser', 'pour ne pas viser'), en), false);
  assert.equal(equivalentNumericFacts('viser la deuxième place', 'in her bid for the leading places'), false);
});

test("exact native V5 Tottenham opening interval preserves scores, ranks and quantities", () => {
  const fr = "Malgr\u00e9 des investissements cons\u00e9quents, Tottenham d\u00e9\u00e7oit grandement depuis quelques temps. L'an pass\u00e9, la formation londonienne avait m\u00eame d\u00fb attendre la derni\u00e8re journ\u00e9e pour sauver sa t\u00eate au sein de l'\u00e9lite. L'objectif est bien \u00e9videmment d'afficher un autre visage cette saison. Malheureusement pour elle et ses supporters, la bande \u00e0 Roberto De Zerbi est reparti sur des bases pr\u00e9occupantes. En effet, les Spurs n'ont remport\u00e9 aucun de leurs six premiers matchs de championnats (3 matchs nuls et 3 d\u00e9faites). Ils ont enfin affich\u00e9 une r\u00e9action lundi dernier en prenant le dessus, \u00e0 domicile, sur le promu Coventry (3-1). Ce succ\u00e8s permet \u00e0 Tottenham de figurer aujourd'hui au 16\u00e8me rang de la premier League avec 1 point d'avance sur le premier rel\u00e9gable. Avantage Chelsea sur la forme";
  const en = "Despite significant investments, Tottenham has been greatly disappointing for some time. Last year, the London team even had to wait until the final matchday to save their place in the elite. The objective is obviously to show a different face this season. Unfortunately for them and their supporters, Roberto De Zerbi's squad has started on a worrying note. Indeed, the Spurs have not won any of their six first league matches (3 draws and 3 defeats). They finally showed a reaction last Monday by overcoming newly promoted Coventry at home (3-1). This success allows Tottenham to currently sit in 16th place in the Premier League with 1 point ahead of the first relegation spot. Advantage Chelsea in terms of form";
  assert.equal(equivalentNumericFacts(fr, en), true);
  for (const mutation of [en.replace("six first league matches", "five first league matches"), en.replace("six first league matches", "six second league matches"), en.replace("16th", "15th"), en.replace("(3-1)", "(1-3)")]) {
    assert.notEqual(mutation, en);
    assert.equal(equivalentNumericFacts(fr, mutation), false);
  }
});

// Exact V6 VIP paragraphs from payload byte SHA256 9b39c203c3dfdd5988eae9658b9520ae3a5872bf25c5b93a43352d8b12112fe3.
const realVip25Paragraphs = [
  [
    "5868102",
    "De son c\u00f4t\u00e9, Getafe est dans ses standings en s'av\u00e9rant indomptable au sein de son Coliseum Alfonso Perez. Cette \u00e9quipe y a d\u00e9croch\u00e9 2 victoires contre Malaga (1-0) et le Racing Santander (1-0) mais aussi 3 matchs nuls pour les r\u00e9ceptions du Celta Vigo (1-1), de La Corogne (1-1) et du Rayo Vallecano lundi soir (1-1), pour la premi\u00e8re de Dani Carvajal sous le maillot azulon. En revanche, les Azulones ont tout de m\u00eame essuy\u00e9 3 d\u00e9faites depuis le d\u00e9but de la saison, \u00e0 chaque fois en d\u00e9placement du c\u00f4t\u00e9 d'Osasuna (1-0), du B\u00e9tis (1-0) et face \u00e0 l'irr\u00e9sistible Barcelone (3-0). Cette semaine, Getafe a manqu\u00e9 \u00e0 son devoir en s'inclinant s\u00e9v\u00e8rement \u00e0 domicile face au champion de Suisse en titre, Lugano (2-5) en Ligue Conf\u00e9rence. Toujours pas de victoire en comp\u00e9tition europ\u00e9enne donc \u00e0 la suite d'un match nul conc\u00e9d\u00e9 en Roumanie contre l'Universitatea Craiova (1-1) la semaine derni\u00e8re. Aucun avantage sur la forme",
    "For their part, Getafe are performing as expected by proving indomitable at their Coliseum Alfonso Perez. This team has claimed 2 victories there against Malaga (1-0) and Racing Santander (1-0) as well as 3 draws when hosting Celta Vigo (1-1), Deportivo La Coru\u00f1a (1-1), and Rayo Vallecano on Monday evening (1-1), for Dani Carvajal's debut in the azulon shirt. On the other hand, the Azulones have still suffered 3 defeats since the start of the season, each time away from home against Osasuna (1-0), Real Betis (1-0), and facing irresistible Barcelona (3-0). This week, Getafe fell short by losing heavily at home to reigning Swiss champions Lugano (2-5) in the Conference League. Still no victory in European competition, therefore, following one draw conceded in Romania against Universitatea Craiova (1-1) last week. No advantage regarding form"
  ],
  [
    "5802969",
    "Lille devance Monaco au classement (4e) malgr\u00e9 un dernier r\u00e9sultat \u00e9galement compromettant. D\u00e9j\u00e0 peu inspir\u00e9s contre Le Havre (victoire 1-0) au retour de la pause de la fen\u00eatre internationale, les Dogues ont \u00e9t\u00e9 tenus en \u00e9chec par Brest (1-1) le week-end dernier, punis d'avoir encaiss\u00e9 le premier but. Olivier Giroud et ses co\u00e9quipiers n'ont par ailleurs pas \u00e9t\u00e9 \u00e0 la hauteur en Ligue des Champions et se d\u00e9placent en Principaut\u00e9 sans avoir gagn\u00e9 lors des 3 derniers matchs. Une semaine apr\u00e8s avoir chut\u00e9 \u00e0 Arsenal (3-0), ils ont \u00e9t\u00e9 surpris sur leur pelouse par Galatasaray (2-4) mercredi. Avant age Monaco sur la forme",
    "Lille lead Monaco in the standings (4th) despite a similarly compromising latest result. Already uninspiring against Le Havre (1-0 win) upon returning from the international window break, the Dogues were held to a draw by Brest (1-1) last weekend, punished for conceding the opening goal. Olivier Giroud and his teammates moreover fell short in the Champions League and are travelling to the Principality without having won any of their last 3 matches. A week after falling at Arsenal (3-0), they were surprised on their own turf by Galatasaray (2-4) on Wednesday. Advantage Monaco regarding form"
  ],
  [
    "5749710",
    "Distanc\u00e9e par les six premiers du classement \u00e0 l'issue du pr\u00e9c\u00e9dent exercice, l'Atalanta a d\u00fb se contenter d'une qualification pour la Ligue Conf\u00e9rence. Cet \u00e9t\u00e9, la Dea a ouvert un nouveau chapitre avec l'arriv\u00e9e sur le banc de l'exp\u00e9riment\u00e9 Maurizio Sarri. Malheureusement, le d\u00e9but de championnat se r\u00e9v\u00e8le poussif. Les Bergamasques ne figurent aujourd'hui qu'au 11\u00e8me rang de la Serie A avec d\u00e9j\u00e0 6 unit\u00e9s de d\u00e9bours sur la 4\u00e8me place. Apr\u00e8s avoir encha\u00een\u00e9 trois revers d'affil\u00e9e, ils ont r\u00e9agi en battant la lanterne rouge Venise (3-1). La Dea a en revanche rechut\u00e9 devant les tifosi du Milan AC le week-end dernier (3-2). Cette semaine, l'Atalanta a perdu sur le terrain de l'Ajax en Ligue Conf\u00e9rence (2-0).",
    "Distanced by the top six of the standings at the end of the previous campaign, Atalanta had to content themselves with qualification for the Conference League. This summer, La Dea opened a new chapter with the arrival on the bench of the experienced Maurizio Sarri. Unfortunately, the start of the championship is proving sluggish. The Bergamasques currently sit only in 11th place in Serie A with already 6 points behind the 4th place. After stringing together three defeats in a row, they reacted by beating bottom side Venezia (3-1). La Dea relapsed again in front of AC Milan's supporters last weekend (3-2). This week, Atalanta lost away to Ajax in the Conference League (2-0)."
  ]
];
for (const [sourceId, fr, en] of realVip25Paragraphs) test('exact native V6 VIP paragraph: ' + sourceId, () => {
  assert.equal(equivalentNumericFacts(fr, en), true);
  const mutations = sourceId === '5868102'
    ? [en.replace('Dani Carvajal', 'Dani Alonso'), en.replace('3 defeats', '4 defeats'), en.replace('(2-5)', '(5-2)'), en.replace("for Dani Carvajal's debut", "not for Dani Carvajal's debut")]
    : sourceId === '5802969'
      ? [en.replace('4th', '5th'), en.replace('(2-4)', '(4-2)'), en.replace('punished for conceding', 'not punished for conceding')]
      : [en.replace('top six', 'top five'), en.replace('11th', '12th'), en.replace('4th', '5th'), en.replace('(3-1)', '(1-3)'), en.replace('the top six', 'not the top six')];
  for (const mutation of mutations) {
    assert.notEqual(mutation, en);
    assert.equal(equivalentNumericFacts(fr, mutation), false);
  }
});

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
