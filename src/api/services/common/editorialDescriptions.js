'use strict';

const { compactEditorialDescription } = require('./compactEditorialDescription');
const { contextualDescription, factualLabel } = require('./editorialTeaser');

const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const market = /\b(?:our (?:pick|bet|selection)|notre (?:choix|pari|prono)|nos (?:choix|paris)|odds|handicaps?|btts|double chance|draw no bet|bookmakers?|bet on|place (?:a|your) bet|pariez|miser|misez|misons|will (?:win|beat|score|draw)|should (?:win|beat|score)|to win|gagnera|gagneront|battront|battra|marquera|marqueront|s imposera|s imposeront|guaranteed (?:win|profit)|gain garanti|score exact|correct score|surebet|banker)\b|\b(?:over|under)\s+\d/u;
const events = rows => rows.flatMap(row => {
  const item = row.payload || row;
  return [item, ...(item.legs || [])];
});

function publicLong(value, rows) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 2400 || /[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
      || /\bcotes?\b/iu.test(value) || market.test(normalize(value))) return null;
  const normalized = ' ' + normalize(value) + ' ';
  const labels = events(rows).flatMap(item => Object.values(item.selection?.label || {}))
    .filter(label => typeof label === 'string').map(normalize).filter(label => label.split(' ').length >= 2);
  if (labels.some(label => normalized.includes(' ' + label + ' '))) return null;
  // Horse names remain inside the protected race reader, even if a generated
  // contextual hook inadvertently names a selected runner without saying pick.
  const horses = events(rows).flatMap(item => item.kind === 'horse_racing' ? item.race?.runners || [] : [])
    .map(runner => typeof runner.name === 'string' ? normalize(runner.name) : '').filter(name => name.length >= 3);
  if (horses.some(name => normalized.includes(' ' + name + ' '))) return null;
  return value;
}

function sourceLong(rows, language) {
  const contextual = publicLong(contextualDescription(rows, language), rows);
  if (contextual) return contextual;
  const chosen = [];
  for (const row of rows.slice(0, 3)) {
    const item = row.payload || row;
    const label = item.race || item.teams || item.kind === 'combine' ? factualLabel(item, language) : '';
    if (label && [...[...chosen, label].join(' • ')].length <= 2400) chosen.push(label);
  }
  return publicLong(chosen.join(' • '), rows);
}

// copy and teaser have already passed their existing immutable item bindings.
// Both descriptions are public copy, never an alternative to reader access.
function editorialDescriptionFields(rows, lang = 'fr', copy = null, teaser = null, { fallback = null } = {}) {
  const language = lang === 'en' ? 'en' : 'fr';
  const empty = language === 'en' ? 'This edition is not available yet.' : 'Cette edition n’est pas encore disponible.';
  const description = (teaser ? teaser.body[language] : compactEditorialDescription(rows, language, copy)) || fallback || empty;
  const longDescription = publicLong(copy?.body?.[language], rows) || sourceLong(rows, language) || description;
  return { description, editorialDescription: description, shortDescription: description, longDescription };
}

module.exports = { editorialDescriptionFields };
