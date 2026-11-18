// Product presentation only. Publisher URLs, stored payloads, fingerprints and
// sourced prose retain their original identities and wording.
const DAILY_ANALYSIS_SOURCE = 'rdj_petit_journal';
const DAILY_ANALYSIS_NAME = Object.freeze({ fr: 'Analyse du jour', en: 'Daily Analysis' });
const pick = (value, language) => typeof value === 'string' ? value : value?.[language] || value?.fr || value?.en || '';

function categoryDisplayName(category, lang = 'fr') {
  const language = lang === 'en' ? 'en' : 'fr';
  return category?.editorialSource === DAILY_ANALYSIS_SOURCE
    ? DAILY_ANALYSIS_NAME[language]
    : pick(category?.name, language);
}

function sourcePresentation(source, lang = 'fr') {
  if (!source) return source;
  return source.key === DAILY_ANALYSIS_SOURCE
    ? { ...source, label: DAILY_ANALYSIS_NAME[lang === 'en' ? 'en' : 'fr'] }
    : source;
}

// Match the mobile display helper: only an exact generic product identity or
// an identity followed solely by an edition date may change. A publisher's
// name at the start of reporting prose does not make it a product title.
const oldProductPrefix = /^(?:(?:le\s+)?petit\s+journal(?:\s+du\s+parieur)?|(?:le\s+)?journal\s+du\s+parieur|(?:the\s+)?daily\s+journal|(?:the\s+)?bettor['’]s\s+journal|(?:the\s+)?bettors['’]\s+journal|analyse\s+du\s+jour|daily\s+analysis)/iu;
function editionDateSuffix(suffix) {
  let date = suffix.trim().replace(/^[·•|:–—-]\s*/u, '').replace(/^(?:du|of|for)\s+/iu, '').trim();
  if (date.startsWith('(') && date.endsWith(')')) date = date.slice(1, -1).trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date);
  }
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/u.test(date)) {
    const parts = date.split(/[/.-]/u).map(Number);
    return parts[0] >= 1 && parts[0] <= 31 && parts[1] >= 1 && parts[1] <= 12;
  }
  const months = 'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|' +
    'septembre|octobre|novembre|décembre|decembre|' +
    'january|february|march|april|may|june|july|august|september|october|november|december|' +
    'jan\\.?|fév\\.?|fev\\.?|feb\\.?|mar\\.?|avr\\.?|apr\\.?|jun\\.?|jui\\.?|jul\\.?|' +
    'aoû\\.?|aou\\.?|aug\\.?|sept?\\.?|oct\\.?|nov\\.?|déc\\.?|dec\\.?';
  const weekdays = 'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
  const prefix = `(?:(?:${weekdays})\\s+)?`;
  const day = '(?:[1-9]|[12]\\d|3[01])(?:er|st|nd|rd|th)?';
  return new RegExp(`^${prefix}${day}\\s+(?:${months})(?:\\s+\\d{4})?$`, 'iu').test(date) ||
    new RegExp(`^${prefix}(?:${months})\\s+${day}(?:,?\\s+\\d{4})?$`, 'iu').test(date);
}
function productTitle(value, source, lang = 'fr') {
  if (source !== DAILY_ANALYSIS_SOURCE) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim(), match = oldProductPrefix.exec(trimmed);
    if (!match) return value;
    const suffix = trimmed.slice(match[0].length);
    if (suffix.trim() && !editionDateSuffix(suffix)) return value;
    return DAILY_ANALYSIS_NAME[lang === 'en' ? 'en' : 'fr'] + suffix;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([language, title]) => [language, productTitle(title, source, language)]));
}

function payloadPresentation(payload, lang = 'fr') {
  if (payload?.source !== DAILY_ANALYSIS_SOURCE) return payload;
  return { ...payload, title: productTitle(payload.title, payload.source, lang) };
}

module.exports = { DAILY_ANALYSIS_SOURCE, DAILY_ANALYSIS_NAME, categoryDisplayName, sourcePresentation, productTitle, payloadPresentation };
