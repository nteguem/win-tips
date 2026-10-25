const { equivalentNumericFacts } = require('./editorialNumericFacts');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
const validText = value => !!value && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const segmenters = Object.fromEntries(['fr', 'en'].map(lang => [lang, new Intl.Segmenter(lang, { granularity: 'sentence' })]));
const market = /\b(?:pronostics?|predictions?|selections?|notre choix|nos choix|notre pari|nos paris|our picks?|our bets?|betting|bets?|stakes?|misez|misons|bookmakers?|cotes?|odds|handicaps?|double chance|draw no bet|btts|over|under|plus de|moins de|more than|less than|both teams (?:to )?score|les (?:deux|2) equipes marquent|pas de vainqueur|no winner|surebet|banker|garanti(?:e|s|es)?)\b/u;
const directOutcome = /^(?:(?:la|une|the|a) )?(?:victoire|victoires|succes|vainqueur|match nul|nul|win|wins|victory|draw)\b|\b(?:to win|will (?:win|beat|score|draw)|(?:can|could|should) (?:win|beat|score)|(?:va|vont|devrait|devraient|pourrait|pourraient) (?:gagner|battre|marquer|s imposer|l emporter)|s imposera|s imposeront|battront|battra|s impose|s imposent|fait un coup|font un coup)\b/u;
const forecast = /\b(?:perdra|perdront|gagnera|gagneront|marquera|marqueront|vaincra|vaincront|eviter la defaite|evitera|eviteront|ne perd|ne perdent|ne perdra|ne perdront|avoid (?:a )?(?:defeat|loss)|won t lose|will not lose|will never lose|should|could|would|devrait|devraient|pourrait|pourraient|sera|seront|favori|favoris|favorite|favorites|favourite|favourites|outsider|outsiders|base solide|banker|probable|probably|likely|prevu|prevue|attendu|attendue|conseille|recommande|recommended|expected|expect|trust|backing)\b/u;
// A blacklist alone cannot distinguish a paraphrased pick from context. Keep
// only recognized retrospective/current-form frames, then reject forecasts.
// Anything ambiguous falls back to public team labels, not free-form prose.
const context = {
  fr: /\b(?:enchaine|enchainent|sur (?:sa|leur) lancee|serie|series|dynamique|reste sur|restent sur|retrouve|retrouvent|actuellement|a ete|ont ete|a remporte|ont remporte|l an passe|saison derniere|apres|points consecutifs?|coup d arret|a rebondi|ont rebondi|s est relance|se sont relances|a aligne|ont aligne|a enregistre|ont enregistre|a concede|ont concede|a perdu|ont perdu|a gagne|ont gagne|a laisse|ont laisse)\b/u,
  en: /\b(?:momentum|run|form|were|was|have|has|had|recorded|currently|are back|is back|looking better|are experiencing|after|last (?:year|season|week|match|game)|previous (?:match|game)|bounced back|to start the season|season opener)\b/u,
};
const english = /\b(?:the|their|they|were|was|has|have|had|are|is|with|after|before|while|since|despite|last|currently|back|keep|looking|recorded|in)\b/u;
const future = /\b(?:will|shall|should|could|would|may|might|must|va|vont|devons|devront|doit|doivent)\b|\b\p{L}{3,}(?:era|eront|ira|iront|ra|ront|rait|raient)\b/u;
const outcomePlan = /\b(?:three points|trois points|to (?:win|beat|score|secure|take|claim|collect|grab|earn|dominate|defeat|prevail|avoid|extend|outclass|overcome)|en (?:battant|dominant)|pour (?:gagner|battre|s imposer|l emporter|prendre|remporter)|looking (?:to|for) (?:win|victory)|looks? (?:set|certain)|(?:sont|est) (?:assure|assures|assuree|assurees))\b/u;
const explicitMarket = /\b(?:(?:home|away) (?:win|victory)|victory (?:at home|away)|victoire (?:a domicile|a l exterieur)|match nul|correct score|score exact|dnb|btts)\b/u;
const derogatory = /\b(?:t?chokeurs?|chokers?|ignobles?|execrables?|atrocious|execrable|pathetiques?|pathetic|lamentables?|disgusting|ridicules?|garbage|horribles?)\b/u;

function selectionLabels(item) {
  return [item, ...(item.legs || [])].flatMap(event => Object.values(event.selection?.label || {}))
    .filter(value => typeof value === 'string' && value.trim()).map(normalize);
}
function safeSentence(value, item, lang = 'fr') {
  if (!validText(value) || [...value].length < 12 || [...value].length > 160) return false;
  const normalized = normalize(value), padded = ' ' + normalized + ' ';
  if (market.test(normalized) || directOutcome.test(normalized) || forecast.test(normalized) || future.test(normalized) || outcomePlan.test(normalized) || explicitMarket.test(normalized) || derogatory.test(normalized) || !context[lang].test(normalized)) return false;
  // Outcome headings after a contextual preamble are still market labels.
  if (value.split(/[,;:\u2013\u2014]|\b(?:mais|but)\b/iu).some(clause => directOutcome.test(normalize(clause)))) return false;
  // Only this closed, outcome-free English momentum question is editorial
  // context; other modal projections must remain inside the protected reader.
  if (/\bcan\b/u.test(normalized) && !/^can [\p{L}\p{N} ]+ keep (?:their|its|the) run going$/u.test(normalized)) return false;
  if (lang === 'en' && !english.test(normalized)) return false;
  return !selectionLabels(item).some(label => label && padded.includes(' ' + label + ' '));
}
function sentenceFrom(original, translated, lang, item, requireActor = false) {
  const candidate = text(lang === 'en' ? translated : original);
  if (!candidate || !validText(candidate)) return null;
  // Never manufacture English or reuse French under an English label. Existing
  // archived EN snippets must at least preserve the original numeric facts.
  if (lang === 'en' && (!text(original) || normalize(original) === normalize(translated) || !equivalentNumericFacts(original, translated))) return null;
  for (const segment of segmenters[lang].segment(candidate)) {
    const sentence = segment.segment.trim();
    if (safeSentence(sentence, item, lang) && (!requireActor || namedActor(sentence, item))) return sentence;
  }
  return null;
}
function contextualSnippet(item, lang) {
  // Race summaries can already name the picked horse. Build their teaser
  // entirely from the same public race metadata used by the safe preview.
  if (item.kind === 'horse_racing') {
    const race = item.race;
    if (!race) return null;
    return [Number.isSafeInteger(race.meetingNumber) && Number.isSafeInteger(race.raceNumber) ? `R${race.meetingNumber}C${race.raceNumber}` : '',
      Number.isSafeInteger(race.distanceMeters) ? `${race.distanceMeters} m` : '',
      Number.isSafeInteger(race.runnersCount) ? `${race.runnersCount} ${lang === 'en' ? 'runners' : 'partants'}` : ''].filter(Boolean).join(' · ') || null;
  }
  const heading = sentenceFrom(item.summary?.fr, item.summary?.en, lang, item);
  if (heading) return heading;
  const sections = lang === 'en' ? item.analysis?.en : item.analysis?.fr;
  for (let section = 0; section < Math.min(sections?.length || 0, 4); section++) {
    const paragraphs = sections[section].paragraphs || [];
    for (let paragraph = 0; paragraph < Math.min(paragraphs.length, 4); paragraph++) {
      const original = item.analysis?.fr?.[section]?.paragraphs?.[paragraph];
      const result = sentenceFrom(original, lang === 'en' ? paragraphs[paragraph] : undefined, lang, item, true);
      if (result) return result;
    }
  }
  return null;
}
function namedActor(sentence, item) {
  const normalized = ' ' + normalize(sentence) + ' ';
  const names = (item.legs || [item]).flatMap(event => event.teams ? [event.teams.home.name, event.teams.away.name] : []);
  return names.some(name => {
    const full = normalize(name);
    return normalized.includes(' ' + full + ' ') || full.split(' ').some(token => token.length >= 4 && normalized.includes(' ' + token + ' '));
  });
}
function factualLabel(item, lang) {
  if (item.race) return [item.race.name, item.race.racecourse].filter(Boolean).join(' \u00b7 ');
  return (item.legs || [item]).map(event => event.teams ? `${event.teams.home.name} \u2014 ${event.teams.away.name}` :
    text(typeof event.title === 'string' ? event.title : event.title?.[lang])).filter(Boolean).join(' / ');
}
function contextualDescription(rows, lang) {
  const parts = rows.slice(0, 3).map(row => {
    const item = row.payload, label = factualLabel(item, lang), snippet = contextualSnippet(item, lang);
    return { rich: !!snippet, value: snippet ? `${label} \u00b7 ${snippet}` : label };
  });
  if (!parts.some(part => part.rich)) return null;
  const chosen = [];
  for (const part of parts) {
    if (!part.value || [...[...chosen, part.value].join(' \u2022 ')].length > 650) break;
    chosen.push(part.value);
  }
  return chosen.length ? chosen.join(' \u2022 ') : null;
}
module.exports = { contextualDescription, contextualSnippet, factualLabel, safeSentence };
