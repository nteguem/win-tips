'use strict';

const { contextualSnippet, factualLabel, safeSentence } = require('./editorialTeaser');
const { equivalentNumericFacts } = require('./editorialNumericFacts');
const { VERSION, V2_VERSION } = require('./editorialCopy');

const LIMIT = 140;
const clean = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
function whole(value, limit = LIMIT) {
  const candidate = clean(value);
  // Never turn a byte-clamped historical body into a supposedly whole teaser.
  // Select another complete candidate instead of adding/removing an ellipsis.
  return candidate && [...candidate].length <= limit && !/\.\.\.|…|[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(candidate) ? candidate : null;
}
const firstEvent = item => item?.kind === 'combine' ? item.legs?.[0] : item;
const payload = row => row?.payload || row;

function labelAndHook(item, hook, lang) {
  if (!hook) return null;
  const label = whole(factualLabel(item, lang));
  return (label && whole(`${label} · ${hook}`)) || whole(hook);
}

// The caller supplies a validated, bound copy. This is a cosmetic projection:
// it never edits cached copy, reader analysis, publication IDs or notifications.
function compactEditorialDescription(rows, lang = 'fr', copy = null, { fallback = null } = {}) {
  const language = lang === 'en' ? 'en' : 'fr';
  const first = Array.isArray(rows) ? payload(rows[0]) : null;
  if (!first) return whole(fallback);
  const event = firstEvent(first);
  if (!event) return whole(fallback) || (language === 'en' ? 'The matches and analysis in this edition.' : 'Les rencontres et analyses de cette édition.');

  // A race analysis or generated hook can name a picked horse. Race previews
  // therefore use public race metadata only, irrespective of the copy version.
  if (event.kind === 'horse_racing') {
    const snippet = whole(contextualSnippet(event, language));
    return labelAndHook(event, snippet, language) || whole(factualLabel(event, language)) ||
      whole(fallback) || (language === 'en' ? 'The race programme and analysis.' : 'Le programme de la course et ses analyses.');
  }

  if (copy?.version === V2_VERSION) {
    const entry = copy.choice?.entries?.[0];
    // Binding can preserve an order different from the API's match-time sort.
    // Pair the first hook with its own event, never an unrelated team's label.
    const matching = Array.isArray(rows) && rows.find(row => String(payload(row)?.sourceId) === String(entry?.id));
    const copyEvent = matching && firstEvent(payload(matching));
    const hook = whole(entry?.notification?.[language], 90);
    const numericMatch = language !== 'en' || equivalentNumericFacts(entry?.notification?.fr || '', hook || '');
    if (copyEvent && copyEvent.kind !== 'horse_racing' && hook && numericMatch && safeSentence(hook, copyEvent, language)) {
      const result = labelAndHook(copyEvent, hook, language);
      if (result) return result;
    }
  }

  const snippet = whole(contextualSnippet(event, language));
  const contextual = labelAndHook(event, snippet, language);
  if (contextual) return contextual;

  // V1 is validated against a fixed public renderer (team labels/questions),
  // unlike free-form hooks. Preserve one whole historical block if it fits.
  if (copy?.version === VERSION) {
    const firstBlock = typeof copy.body?.[language] === 'string' ? copy.body[language].split(' • ')[0] : null;
    const archived = whole(copy.body?.[language]) || whole(firstBlock);
    if (archived) return archived;
  }

  // Do not use a combine title: it can already contain its protected selection.
  // Likewise a malformed match without teams cannot promote its raw title.
  const label = event.teams ? whole(factualLabel(event, language)) : null;
  return label || whole(fallback) || (language === 'en' ? 'The matches and analysis in this edition.' : 'Les rencontres et analyses de cette édition.');
}

module.exports = { compactEditorialDescription };
