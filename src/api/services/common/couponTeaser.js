'use strict';

const crypto = require('crypto');
const { checkedFacts, factsFromBatch, digest } = require('./editorialCopy');
const VERSION = 'wintips-coupon-teaser-v1';
const LIMIT = 100;
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const publicMarket = /\b(?:our (?:pick|bet|selection)|notre (?:choix|pari|prono)|nos (?:choix|paris)|odds|handicaps?|btts|double chance|draw no bet|bookmakers?|bet on|place (?:a|your) bet|pariez|miser|misez|misons|will (?:win|beat|score|draw)|should (?:win|beat|score)|to win|gagnera|gagneront|battront|battra|marquera|marqueront|s imposera|s imposeront|guaranteed (?:win|profit)|gain garanti|score exact|correct score|surebet|banker)\b|\b(?:over|under)\s+\d/u;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
function sortedFacts(facts) {
  const result = checkedFacts(facts);
  result.items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return result;
}
function teaserFactsFromBatch(batch) {
  const items = batch.items.flatMap(item => item.kind === 'combine' ? item.legs.map(leg => ({ ...leg,
    sourceId: 'leg-' + digest([item.sourceId, leg.sourceId]),
  })) : [item]);
  return sortedFacts(factsFromBatch({ source: batch.source, editionDate: batch.editionDate, items }));
}
function validateTeaser(facts, value) {
  if (!exact(value, ['version', 'sourceHash', 'body']) || value.version !== VERSION
      || value.sourceHash !== digest(sortedFacts(facts)) || !exact(value.body, ['fr', 'en'])) throw Error('INVALID_COUPON_TEASER');
  for (const language of ['fr', 'en']) {
    const text = value.body[language];
    if (typeof text !== 'string' || !text.trim() || text !== text.trim() || [...text].length > LIMIT || !/[.!?]$/u.test(text)
        || /[.!?]\s+\S|[<>`*_#\u2022\p{Cc}\p{Cf}\p{Cs}]|\u2026|\.\./u.test(text) || /\bcotes?\b/iu.test(text)
        || publicMarket.test(normalize(text))) throw Error('INVALID_COUPON_TEASER');
  }
  return JSON.parse(JSON.stringify(value));
}
function validateForItems(source, editionDate, items, value) {
  const teaser = validateTeaser(teaserFactsFromBatch({ source, editionDate, items }), value);
  const labels = items.flatMap(item => [item, ...(item.legs || [])]).flatMap(item => Object.values(item.selection?.label || {}))
    .filter(label => typeof label === 'string').map(normalize).filter(label => label.split(' ').length >= 2);
  if (Object.values(teaser.body).some(text => labels.some(label => (' ' + normalize(text) + ' ').includes(' ' + label + ' ')))) throw Error('INVALID_COUPON_TEASER');
  return teaser;
}
function boundTeaser(record, rows) {
  try {
    if (!record || record.appId !== 'wintips' || record._id !== `wintips:${record.source}:${record.editionDate}`
        || record.initialized !== true || !record.couponTeaser || !Array.isArray(rows) || !rows.length) return null;
    const unique = new Map();
    for (const row of rows) {
      const item = row.payload;
      if (row.source !== record.source || row.editionDate !== record.editionDate || row.isPublished !== true
          || item?.source !== row.source || item?.editionDate !== row.editionDate || item?.sourceId !== row.sourceId) return null;
      const hash = crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
      if (row.contentHash !== hash || (unique.has(row.sourceId) && unique.get(row.sourceId).hash !== hash)) return null;
      unique.set(row.sourceId, { hash, item });
    }
    const items = [...unique.values()].map(value => value.item);
    // A readable caption must not expose a selection already present in the
    // protected reader, even when the provider ignores its authoring prompt.
    return validateForItems(record.source, record.editionDate, items, record.couponTeaser);
  } catch (_) { return null; }
}
function teaserForOperations(context, operations) {
  try {
    if (!context.couponTeaser) return null;
    const unique = new Map();
    for (const { updateOne: operation } of operations) {
      const item = operation.update.$set.payload;
      if (item.source !== context.source || item.editionDate !== context.editionDate) return null;
      const prior = unique.get(item.sourceId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(item)) return null;
      unique.set(item.sourceId, item);
    }
    return validateForItems(context.source, context.editionDate, [...unique.values()], context.couponTeaser);
  } catch (_) { return null; }
}
module.exports = { VERSION, LIMIT, sortedFacts, teaserFactsFromBatch, validateTeaser, boundTeaser, teaserForOperations };
