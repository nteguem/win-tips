// Mirrors rdj-source-hub/editorial_copy.py. This renders a closed factual
// question; the model selects an angle and never supplies publishable prose.
const crypto = require('crypto');
const { failure } = require('./editorialSources');
const VERSION = 'rdj-editorial-copy-v1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = () => { throw failure('Copie editoriale invalide', 400, 'EDITORIAL_COPY_INVALID'); };
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !own(value, key))) invalid();
}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return invalid();
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function text(value, limit = 200) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit || /[\x00-\x1f<>]/u.test(value)) invalid();
  return value;
}
function utc(value) {
  text(value, 40);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return new Date(value).toISOString();
}
function checkedFacts(facts) {
  exact(facts, ['source', 'editionDate', 'items']); text(facts.source, 80);
  if (typeof facts.editionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(facts.editionDate) || !Array.isArray(facts.items) || !facts.items.length || facts.items.length > 50) invalid();
  const ids = new Set();
  for (const row of facts.items) {
    const racing = row?.kind === 'horse_racing';
    exact(row, ['id', 'kind', 'startsAtUtc', 'contextFr', ...(racing ? ['race', 'racecourse'] : ['home', 'away', 'sport', 'competition'])]);
    if (!['match', 'horse_racing'].includes(row.kind) || utc(row.startsAtUtc) !== row.startsAtUtc) invalid();
    text(row.id); if (ids.has(row.id)) invalid(); ids.add(row.id);
    if (typeof row.contextFr !== 'string' || [...row.contextFr].length > 40000) invalid();
    for (const key of racing ? ['race', 'racecourse'] : ['home', 'away', 'sport']) text(row[key]);
    if (!racing && (typeof row.competition !== 'string' || [...row.competition].length > 200)) invalid();
    if (!racing && row.competition) text(row.competition);
  }
  return clone(facts);
}
function factsFromBatch(batch) {
  return checkedFacts({ source: batch.source, editionDate: batch.editionDate, items: batch.items.map(item => {
    const event = item.kind === 'combine' ? item.legs[0] : item;
    const row = { id: text(item.sourceId), kind: event.kind, startsAtUtc: utc(event.startsAtUtc),
      contextFr: (event.analysis?.fr || []).flatMap(section => section.paragraphs || []).join('\n\n') };
    return event.kind === 'horse_racing' ? { ...row, race: event.race.name, racecourse: event.race.racecourse || event.race.name } :
      { ...row, home: event.teams.home.name, away: event.teams.away.name, sport: event.sport.key, competition: event.competition?.name || '' };
  }) });
}
function render(facts, choice) {
  exact(choice, ['angle', 'focusIds']);
  if (!['duel', 'stakes', 'competition', 'race'].includes(choice.angle) || canonical(choice.focusIds) !== canonical(facts.items.map(row => row.id))) invalid();
  const parts = facts.items.map(row => renderOne(row, choice.angle));
  const body = Object.fromEntries(['fr', 'en'].map(language => [language, parts.map(part => part[language]).join(' \u2022 ')]));
  if (Object.values(body).some(value => [...value].length > 800)) invalid();
  return body;
}
function renderOne(row, angle) {
  let body;
  if (row.kind === 'horse_racing') {
    if (angle !== 'race') invalid();
    const label = row.race + ' \u00b7 ' + row.racecourse;
    body = { fr: label + ' : quels enjeux sur la piste ?', en: label + ': what awaits on the track?' };
  } else {
    const label = row.home + ' \u2014 ' + row.away;
    if (angle === 'race') invalid();
    if (angle === 'competition') {
      if (!row.competition) invalid();
      body = { fr: label + ' \u00b7 ' + row.competition + ' : quel sc\u00e9nario ?', en: label + ' \u00b7 ' + row.competition + ': how will the contest unfold?' };
    } else if (angle === 'stakes') body = { fr: label + ' : quels enjeux pour cette rencontre ?', en: label + ': what is at stake in this contest?' };
    else body = { fr: label + ' : quel visage pour ce duel ?', en: label + ': how will this matchup unfold?' };
  }
  return body;
}
function fallback(facts) {
  const sourceIds = facts.items.map(row => row.id);
  let choice = { angle: facts.items[0].kind === 'horse_racing' ? 'race' : 'duel', focusIds: sourceIds }, body;
  try { body = render(facts, choice); }
  catch (_) {
    choice = { angle: 'labels', focusIds: sourceIds };
    const labels = facts.items.map(row => row.kind === 'horse_racing' ? row.race + ' \u00b7 ' + row.racecourse : row.home + ' \u2014 ' + row.away).join(' \u2022 ');
    if ([...labels].length > 800) invalid();
    body = { fr: labels, en: labels };
  }
  return { version: VERSION, sourceHash: digest(facts), sourceIds, choice, body,
    method: 'deterministic_fallback', model: null, cacheKey: null, nativeSha256: null };
}
function validateCopy(facts, value) {
  exact(value, ['version', 'sourceHash', 'sourceIds', 'choice', 'body', 'method', 'model', 'cacheKey', 'nativeSha256']);
  if (value.version !== VERSION || value.sourceHash !== digest(facts) || canonical(value.sourceIds) !== canonical(facts.items.map(row => row.id))) invalid();
  if (value.method === 'deterministic_fallback') {
    if (canonical(value) !== canonical(fallback(facts))) invalid();
  } else if (value.method === 'gemini') {
    if (typeof value.model !== 'string' || !/^gemini-[a-z0-9][a-z0-9.-]{1,79}$/.test(value.model) ||
      ['cacheKey', 'nativeSha256'].some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) || canonical(value.body) !== canonical(render(facts, value.choice))) invalid();
  } else invalid();
  return clone(value);
}
function notificationSnapshot(group) {
  const items = group.items.map(row => {
    const contentHash = crypto.createHash('sha256').update(JSON.stringify(row.payload)).digest('hex');
    if (row.contentHash !== undefined && row.contentHash !== contentHash) throw failure('Contenu de notification incoherent', 409, 'EDITORIAL_NOTIFICATION_SNAPSHOT_CHANGED');
    return { id: String(row._id), sourceId: row.sourceId || row.payload.sourceId, contentHash };
  });
  return { editorialCopy: group.editorialCopy || null, editorialCopySha256: group.editorialCopy ? digest(group.editorialCopy) : null, itemHash: digest(items) };
}
// Return a copy only while every original item and its facts remain bound.
// No historic item is reworded or re-qualified by this cosmetic read path.
function boundCopy(record, rows) {
  try {
    if (!record || record.appId !== 'wintips' || record._id !== 'wintips:' + record.source + ':' + record.editionDate ||
      record.initialized !== true || record.legacy !== false || !record.copy || record.copySha256 !== digest(record.copy)) return null;
    if (!Array.isArray(record.itemHashes) || record.itemHashes.length !== rows.length) return null;
    const items = record.copy.sourceIds.map(sourceId => {
      const candidates = rows.filter(row => row.sourceId === sourceId && row.source === record.source && row.editionDate === record.editionDate && row.isPublished === true);
      if (candidates.length !== 1) invalid();
      const row = candidates[0], expected = record.itemHashes.find(item => item.sourceId === sourceId);
      const actual = crypto.createHash('sha256').update(JSON.stringify(row.payload)).digest('hex');
      if (!expected || expected.contentHash !== actual || row.contentHash !== actual) invalid();
      return row.payload;
    });
    return validateCopy(factsFromBatch({ source: record.source, editionDate: record.editionDate, items }), record.copy);
  } catch (_) { return null; }
}
module.exports = { VERSION, canonical, digest, checkedFacts, factsFromBatch, render, fallback, validateCopy, notificationSnapshot, boundCopy };
