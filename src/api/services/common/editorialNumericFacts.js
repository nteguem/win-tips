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
  // These complete sporting expressions have faithful qualitative English
  // equivalents without a numeric ordinal. Pair their exact multiplicities;
  // never suppress a standalone first/second or any other rank/quantity.
  const qualitativePairs = [
    [/(?<!\p{L})premier\s+poursuivant(?!\p{L})/giu, /\bclosest\s+pursuer\b/giu],
    [/(?<!\p{L})seconde\s+partie\s+de\s+tableau(?!\p{L})/giu, /\b(?:lower|bottom)\s+half\s+of\s+the\s+table\b/giu],
    [/(?<!\p{L})un\s+premier\s+rôle(?!\p{L})/giu, /\ba\s+leading\s+role\b/giu],
    [/(?<!\p{L})premier\s+match\s+de\s+la\s+saison(?!\p{L})/giu, /\bseason\s+opener\b/giu, true],
  ];
  for (const [french, english, requirePair] of qualitativePairs) {
    const count = [...source.matchAll(french)].length;
    const translatedCount = [...target.matchAll(english)].length;
    if (requirePair && translatedCount && count !== translatedCount) return { source, target, valid: false };
    if (count && count === translatedCount) {
      source = source.replace(french, 'paired qualitative expression');
      target = target.replace(english, 'paired qualitative expression');
    }
  }
  // An opening N-event interval carries the quantity N, not a separate rank
  // of one. License either English word order from that closed French frame;
  // never erase first in a place/rank/finish label or an unrelated expression.
  const countToken = '(?:\\d+|' + Object.keys(CARDINALS).sort((a, b) => b.length - a.length).join('|') + ')';
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
  text = text.replace(cardinalPattern, match => String(CARDINALS[match]));
  const ordinals = [];
  text = text.replace(numericOrdinal, (match, digits) => { ordinals.push(number(digits)); return digits; });
  text = text.replace(ordinalPattern, match => { const value = ORDINALS[match]; ordinals.push(String(value)); return String(value); });
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
