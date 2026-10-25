'use strict';

// This checks numeric equivalence, not translation quality. The worker still
// validates actors, outcomes and chronology before producing either language.
const CARDINALS = {
  zero: 0, zéro: 0, two: 2, deux: 2, three: 3, trois: 3,
  four: 4, quatre: 4, five: 5, cinq: 5, six: 6, seven: 7, sept: 7,
  eight: 8, huit: 8, nine: 9, neuf: 9, ten: 10, dix: 10,
  eleven: 11, onze: 11, twelve: 12, douze: 12, thirteen: 13, treize: 13,
  fourteen: 14, quatorze: 14, fifteen: 15, quinze: 15, sixteen: 16, seize: 16,
  seventeen: 17, 'dix-sept': 17, eighteen: 18, 'dix-huit': 18,
  nineteen: 19, 'dix-neuf': 19, twenty: 20, vingt: 20,
};
const ORDINALS = {
  first: 1, premier: 1, première: 1, premiers: 1, premières: 1,
  second: 2, seconde: 2, seconds: 2, secondes: 2, deuxième: 2, deuxièmes: 2,
  third: 3, troisième: 3, troisièmes: 3, fourth: 4, quatrième: 4, quatrièmes: 4,
  fifth: 5, cinquième: 5, cinquièmes: 5, sixth: 6, sixième: 6, sixièmes: 6,
  seventh: 7, septième: 7, septièmes: 7, eighth: 8, huitième: 8, huitièmes: 8,
  ninth: 9, neuvième: 9, neuvièmes: 9, tenth: 10, dixième: 10, dixièmes: 10,
  eleventh: 11, onzième: 11, onzièmes: 11, twelfth: 12, douzième: 12, douzièmes: 12,
  thirteenth: 13, treizième: 13, treizièmes: 13, fourteenth: 14, quatorzième: 14, quatorzièmes: 14,
  fifteenth: 15, quinzième: 15, quinzièmes: 15, sixteenth: 16, seizième: 16, seizièmes: 16,
  seventeenth: 17, 'dix-septième': 17, 'dix-septièmes': 17,
  eighteenth: 18, 'dix-huitième': 18, 'dix-huitièmes': 18,
  nineteenth: 19, 'dix-neuvième': 19, 'dix-neuvièmes': 19,
  twentieth: 20, vingtième: 20, vingtièmes: 20,
};
const wordPattern = values => new RegExp('(?<![\\p{L}])(?:' + Object.keys(values).sort((a, b) => b.length - a.length).join('|') + ')(?![\\p{L}])', 'giu');
const cardinalPattern = wordPattern(CARDINALS), ordinalPattern = wordPattern(ORDINALS);
const numericOrdinal = /\b(\d+)(?:st|nd|rd|th|èmes?|emes?|ers?|ères?|eres?|es?|e)\b/giu;
const amount = '[+-]?\\d+(?:[.,]\\d+)?';
const sort = values => [...values].sort();
const equal = (a, b) => JSON.stringify(sort(a)) === JSON.stringify(sort(b));
const number = value => {
  const normalized = value.replace(',', '.'), negative = normalized.startsWith('-');
  let [integer, fraction = ''] = normalized.replace(/^[+-]/u, '').split('.');
  integer = integer.replace(/^0+(?=\d)/u, ''); fraction = fraction.replace(/0+$/u, '');
  const result = integer + (fraction ? '.' + fraction : '');
  return negative && result !== '0' ? '-' + result : result;
};
const ONE_UNITS = {
  point: ['point'], goal: ['but'], win: ['victoire'], victory: ['victoire'],
  defeat: ['défaite'], loss: ['défaite'], match: ['match', 'rencontre'],
  game: ['match', 'rencontre', 'partie'], title: ['titre'], season: ['saison'],
  year: ['an', 'année'], day: ['jour', 'journée'],
};

function normalizePairedForms(fr, en) {
  let source = String(fr).normalize('NFC'), target = String(en).normalize('NFC');
  const countToken = '(?:\\d+|' + Object.keys(CARDINALS).sort((a, b) => b.length - a.length).join('|') + ')';
  const negativeNear = (text, match) => {
    const before = text.slice(0, match.index).trim().split(/\s+/u).slice(-10).join(' ');
    const after = text.slice(match.index + match[0].length).trim().split(/\s+/u).slice(0, 10).join(' ');
    return /(?<!\p{L})(?:ne|pas|jamais|sans|aucun(?:e|s|es)?|ni|not|never|no|without|cannot|neither|nor)(?!\p{L})|(?<!\p{L})n['’]\p{L}+|\p{L}+n['’]t(?!\p{L})/iu.test(before + ' ' + match[0] + ' ' + after);
  };
  const negativeInClauseNear = (text, match) => {
    const before = text.slice(0, match.index).split(/[.!?;:\n]/u).at(-1);
    const after = text.slice(match.index + match[0].length).split(/[.!?;:\n]/u)[0];
    return negativeNear(before + match[0] + after, { 0: match[0], index: before.length });
  };
  const countValue = token => Object.hasOwn(CARDINALS, token.toLowerCase()) ? String(CARDINALS[token.toLowerCase()]) : number(token);
  const person = "[\\p{Lu}][\\p{L}\\p{M}'’.-]*(?:\\s+[\\p{Lu}][\\p{L}\\p{M}'’.-]*){0,4}";
  // These closed sporting frames express an opening event/group, not an
  // extra rank of one. Pair the entire frame and its multiplicity, retaining
  // the top-N count or exact person/shirt identity. Other ordinals remain.
  const sportingFrames = [
    [new RegExp('(?<!\\p{L})les\\s+(' + countToken + ')\\s+premiers\\s+du\\s+classement(?!\\p{L})', 'giu'),
      new RegExp('\\bthe\\s+top\\s+(' + countToken + ')\\s+of\\s+the\\s+standings\\b', 'giu'),
      match => countValue(match[1]), match => countValue(match[1]) + ' ranked clubs'],
    [/(?<!\p{L})punis\s+d['’]avoir\s+encaissé\s+le\s+premier\s+but(?!\p{L})/giu,
      /\bpunished\s+for\s+conceding\s+the\s+opening\s+goal\b/giu,
      () => 'conceded opening goal', () => 'conceded opening goal'],
    [new RegExp("(?<!\\p{L})[Pp]our\\s+la\\s+première\\s+de\\s+(" + person + ")\\s+sous\\s+le\\s+maillot\\s+([\\p{Ll}-]+)(?!\\p{L})", 'gu'),
      new RegExp("\\b[Ff]or\\s+(" + person + ")[’']s\\s+debut\\s+in\\s+the\\s+([\\p{Ll}-]+)\\s+shirt\\b", 'gu'),
      match => match[1].toLowerCase() + ':' + match[2], () => 'paired shirt debut'],
  ];
  for (const [french, english, identity, replacement] of sportingFrames) {
    const sourceMatches = [...source.matchAll(french)], targetMatches = [...target.matchAll(english)];
    if (!sourceMatches.length || !targetMatches.length) continue;
    if (!equal(sourceMatches.map(identity), targetMatches.map(identity)) ||
        sourceMatches.some(match => negativeInClauseNear(source, match)) ||
        targetMatches.some(match => negativeInClauseNear(target, match))) return { source, target, valid: false };
    source = source.replace(french, (...args) => replacement(args));
    target = target.replace(english, (...args) => replacement(args));
  }
  // The first team outside the relegation zone is the safety boundary. Pair
  // only an explicit, unchanged points deficit; no separate rank is asserted
  // by "N points adrift of safety". Other ranks/quantities stay untouched.
  const safetyFr = new RegExp('(?<!\\p{L})à\\s+(' + countToken + ')\\s+(?:longueurs?|points?)\\s+du\\s+premier\\s+non[- ]relégable(?!\\p{L})', 'giu');
  const safetyEn = new RegExp('(?<![\\p{L}\\p{N}_+−.,:/-])(' + countToken + ')\\s+points?\\s+adrift\\s+of\\s+safety(?!\\p{L})', 'giu');
  const frenchDeficits = [...source.matchAll(safetyFr)], englishDeficits = [...target.matchAll(safetyEn)];
  const deficitCount = match => {
    const token = match[1].toLowerCase();
    return Object.hasOwn(CARDINALS, token) ? String(CARDINALS[token]) : number(token);
  };
  if (englishDeficits.length) {
    if (!equal(frenchDeficits.map(deficitCount), englishDeficits.map(deficitCount)) ||
        frenchDeficits.some(match => negativeNear(source, match)) ||
        englishDeficits.some(match => negativeNear(target, match) || /(?:[+−-]|\b(?:minus|negative|plus|positive))\s*$/iu.test(target.slice(0, match.index)))) {
      return { source, target, valid: false };
    }
    source = source.replace(safetyFr, match => match.replace(/premier\s+non[- ]relégable/iu, 'safety boundary'));
  }
  // These complete sporting expressions have faithful qualitative English
  // equivalents without a numeric ordinal. Pair their exact multiplicities;
  // never suppress a standalone first/second or any other rank/quantity.
  const qualitativePairs = [
    [/(?<!\p{L})premier\s+poursuivant(?!\p{L})/giu, /\bclosest\s+pursuer\b/giu],
    [/(?<!\p{L})seconde\s+partie\s+de\s+tableau(?!\p{L})/giu, /\b(?:lower|bottom)\s+half\s+of\s+the\s+table\b/giu],
    [/(?<!\p{L})un\s+premier\s+rôle(?!\p{L})/giu, /\ba\s+leading\s+role\b/giu],
    [/(?<!\p{L})premier\s+match\s+de\s+la\s+saison(?!\p{L})/giu, /\bseason\s+opener\b/giu, true],
    [/(?<!\p{L})viser\s+les\s+premières\s+places(?!\p{L})/giu, /\bin\s+(?:pursuit\s+of|(?:his|her|its|their)\s+bid\s+for)\s+the\s+leading\s+places\b/giu, true, true],
    [/(?<!\p{L})de\s+retour\s+au\s+premier\s+plan(?!\p{L})/giu, /\bback\s+at\s+the\s+forefront\b/giu, true, true],
  ];
  for (const [french, english, requirePair, requireSourcePair] of qualitativePairs) {
    const sourceMatches = [...source.matchAll(french)], targetMatches = [...target.matchAll(english)];
    const count = sourceMatches.length, translatedCount = targetMatches.length;
    if ((requirePair && translatedCount || requireSourcePair && count) && count !== translatedCount) return { source, target, valid: false };
    if (requireSourcePair && (sourceMatches.some(match => negativeNear(source, match)) || targetMatches.some(match => negativeNear(target, match)))) return { source, target, valid: false };
    if (count && count === translatedCount) {
      source = source.replace(french, 'paired qualitative expression');
      target = target.replace(english, 'paired qualitative expression');
    }
  }
  // An opening N-event interval carries the quantity N, not a separate rank
  // of one. License either English word order from that closed French frame;
  // never erase first in a place/rank/finish label or an unrelated expression.
  const eventFr = new RegExp('(?<![\\p{L}\\p{N}_])(' + countToken + ')\\s+premi(?:ers|ères)\\s+(matchs?|rencontres?|journées?)(?!\\p{L})', 'giu');
  const eventEn = new RegExp('(?<![\\p{L}\\p{N}_])(?:first\\s+(' + countToken + ')|(' + countToken + ')\\s+first)\\s+(?:league\\s+)?(matches|games|fixtures|matchdays?)(?!\\p{L})', 'giu');
  const intervalKey = (count, unit, language) => {
    const token = count.toLowerCase(), value = Object.hasOwn(CARDINALS, token) ? String(CARDINALS[token]) : number(token);
    const kind = language === 'fr' ? (unit.toLowerCase().startsWith('journée') ? 'day' : 'match') : (unit.toLowerCase().startsWith('matchday') ? 'day' : 'match');
    return value + ':' + kind;
  };
  const sourceIntervals = [...source.matchAll(eventFr)].map(match => intervalKey(match[1], match[2], 'fr'));
  const targetIntervals = [...target.matchAll(eventEn)].map(match => intervalKey(match[1] || match[2], match[3], 'en'));
  if (targetIntervals.length && !equal(sourceIntervals, targetIntervals)) return { source, target, valid: false };
  source = source.replace(eventFr, match => match.replace(/premi(?:ers|ères)/iu, 'opening'));
  if (targetIntervals.length) target = target.replace(eventEn, match => match.replace(/\bfirst\b/iu, 'opening'));
  // A top-N finish also carries N, not a second rank of one. Retain this
  // previously supported quantity in its explicit French ranking context.
  const topFr = new RegExp('\\b(?:dans|parmi)\\s+les\\s+(' + countToken + ')\\s+premi(?:ers|ères)(?!\\p{L})', 'giu');
  source = source.replace(topFr, match => match.replace(/premi(?:ers|ères)/iu, 'ranked'));
  const openingFr = /(?<!\p{L})premières\s+performances(?!\p{L})/giu;
  const openingEn = /\b(?:early|initial)\s+performances\b/giu;
  const sourceOpenings = [...source.matchAll(openingFr)].length;
  // This plural describes early form, not first place. Pair the occurrences;
  // a numbered interval or an ordinal elsewhere still retains its quantity.
  if (sourceOpenings && sourceOpenings === [...target.matchAll(openingEn)].length) {
    source = source.replace(openingFr, 'opening performances');
    target = target.replace(openingEn, 'opening performances');
  }
  const twice = [...target.matchAll(/\btwice\b/giu)];
  if (!twice.length) return { source, target, valid: true };
  const sourceLosses = [...source.matchAll(/\bperdre\s+à\s+(?:2|deux)\s+reprises\b/giu)];
  const targetLosses = [...target.matchAll(/\blosing\s+twice(?=\s*(?:[,.;!?]|$))/giu)];
  const affirmativePrefix = (text, index, before) => !text.slice(0, index).trim() || before.test(text.slice(0, index));
  // "Twice" is accepted only as two affirmative losses, never as an omitted
  // number for wins/goals or as an extra occurrence. The real result group is
  // "avant de perdre à 2 reprises, ..." / "before losing twice, ...".
  if (!sourceLosses.length || sourceLosses.length !== targetLosses.length || twice.length !== targetLosses.length ||
      /\b(?:once|thrice)\b/iu.test(target) ||
      sourceLosses.some(match => !affirmativePrefix(source, match.index, /\bavant\s+de\s+$/iu)) ||
      targetLosses.some(match => !affirmativePrefix(target, match.index, /\bbefore\s+$/iu))) {
    return { source, target, valid: false };
  }
  source = source.replace(/\bperdre\s+à\s+(?:2|deux)\s+reprises\b/giu, 'perdre 2 reprises');
  target = target.replace(/\blosing\s+twice(?=\s*(?:[,.;!?]|$))/giu, 'losing 2 times');
  return { source, target, valid: true };
}

function normalizeOneStatistics(fr, en) {
  // "One" is otherwise a pronoun/indefinite article. Treat it as a quantity
  // only before a statistical unit, and normalize the same unit in French.
  let source = String(fr), target = String(en);
  const units = [...target.toLowerCase().matchAll(/\bone(?:\s+(?:single|little))*\s+(point|goal|win|victory|defeat|loss|match|game|title|season|year|day)\b/gu)].map(match => match[1]);
  for (const unit of new Set(units)) {
    target = target.replace(new RegExp('\\b(?:one|a|an)(?:\\s+(?:single|little))*\\s+(?=' + unit + '\\b)', 'giu'), '1 ');
    source = source.replace(new RegExp('(?<!\\p{L})(?:un|une)(?:\\s+(?:seul|seule|petit|petite))*\\s+(?=(?:' + ONE_UNITS[unit].join('|') + ')(?!\\p{L}))', 'giu'), '1 ');
  }
  return [source, target];
}

function normalize(value, language) {
  let text = String(value).normalize('NFC').toLowerCase().replace(/[’‘]/g, "'");
  text = text.replace(/−/gu, '-').replace(/(?<=\d)[‐‑‒–—](?=\d)/gu, '-');
  // Proper competition names and these ranking-free idioms do not assert an
  // ordinal. Keep this list explicit rather than ignoring ordinal words.
  text = text.replace(/\bpremier league\b/gu, 'premierleague')
    .replace(/\bpremiers rôles\b/gu, 'leading roles')
    .replace(/(?<!\p{L})(?:équipe première|première équipe)(?!\p{L})/gu, 'senior team')
    .replace(/\bfirst team\b(?!\s+(?:outside|above|below|to)\b)/gu, 'senior team');
  // Thousands follow the language's notation. Decimal commas remain decimals
  // in French; a change from 1,50 to 150 must never become equivalent.
  if (language === 'en') text = text.replace(/\b\d{1,3}(?:,\d{3})+\b/g, match => match.replace(/,/g, ''));
  text = text.replace(/\b\d{1,3}(?:[ \u00a0\u202f]\d{3})+\b/g, match => match.replace(/[ \u00a0\u202f]/g, ''));
  const ordinals = [];
  text = text.replace(numericOrdinal, (match, digits) => { ordinals.push(number(digits)); return digits; });
  // Resolve a whole ordinal before its cardinal components (dix-septième).
  text = text.replace(ordinalPattern, (match, offset, whole) => {
    const value = ORDINALS[match];
    // Do not read cent-onzième as eleven; retain first-place and similar ranks.
    if (value >= 11 && /[\p{L}\p{N}_-]/u.test(whole[offset - 1] || '')) return match;
    ordinals.push(String(value)); return String(value);
  });
  text = text.replace(cardinalPattern, match => String(CARDINALS[match]));
  // A three-pointer is an explicit three-point unit even when French uses the
  // conventional term "tir primé". It is not an additional made shot.
  text = text.replace(/\btirs? primés?\b/gu, '3 point shot');
  // The repeated quantity is explicit in this narrow source construction.
  const defeatRepetitions = [];
  text = text.replace(/\b(\d{1,2})\s+(journées?|matchs?)\s+et\s+autant de défaites\b/gu,
    (match, count, unit) => { defeatRepetitions.push(count); return count + ' ' + unit + ' et ' + count + ' défaites'; });
  text = text.replace(/\b(\d{1,2})\s+(matchdays?|matches|games)\s+and\s+as many defeats\b/gu, '$1 $2 and $1 defeats');
  return { text, ordinals, defeatRepetitions };
}

function equivalentNumericFacts(fr, en) {
  const paired = normalizePairedForms(fr, en);
  if (!paired.valid) return false;
  const [sourceText, targetText] = normalizeOneStatistics(paired.source, paired.target);
  const source = normalize(sourceText, 'fr'), target = normalize(targetText, 'en');
  // "Both" is numeric only for these explicit two-team/two-side statements.
  // A repeated "both" therefore retains its multiplicity rather than vanishing.
  if (/\b(?:les\s+)?2\s+(?:équipes|marquent)|\b2\s+côtés\b/u.test(source.text)) {
    target.text = target.text.replace(/\bboth (?=teams(?: to score)?\b|sides\b)/gu, '2 ');
  }
  // Interpreting "as many defeats" is allowed only when that same repeated
  // count remains attached to defeats/losses after the matching match count.
  const repetitions = [...target.text.matchAll(/\b(\d{1,2})\s+(?:matchdays?|matches|games)(?:\s*,\s*|\s+(?:(?:and|with)\s+)?)(?:(?:have|suffered)\s+)?\1\s+(?:defeats|losses)\b/gu)].map(match => match[1]);
  for (const count of source.defeatRepetitions) {
    const index = repetitions.indexOf(count);
    if (index < 0) return false;
    repetitions.splice(index, 1);
  }
  const collect = (text, expression, mapper = match => match[0]) => [...text.matchAll(expression)].map(mapper);
  const scores = text => collect(text, /\b(\d+)\s*[-–]\s*(\d+)\b/gu, match => number(match[1]) + '-' + number(match[2]));
  const percentages = text => collect(text, new RegExp('(' + amount + ')\\s*%', 'gu'), match => number(match[1]));
  const times = text => collect(text, /\b(\d{1,2})\s*[:h]\s*(\d{2})\b/gu, match => number(match[1]) + ':' + match[2]);
  const quantities = text => collect(text, new RegExp(amount, 'gu'), match => number(match[0]));
  return equal(source.ordinals, target.ordinals) && equal(scores(source.text), scores(target.text)) &&
    equal(percentages(source.text), percentages(target.text)) && equal(times(source.text), times(target.text)) &&
    equal(quantities(source.text), quantities(target.text));
}

module.exports = { equivalentNumericFacts };
