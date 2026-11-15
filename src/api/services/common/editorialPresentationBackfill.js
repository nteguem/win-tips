// Pure planning only. This module neither connects to Mongo nor writes data.
const crypto = require('node:crypto');

const digest = payload => crypto.createHash('sha256')
  .update(JSON.stringify(payload)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function fail(message) { throw new Error(message); }
function datedJournal(url, day) {
  if (typeof url !== 'string' || !/^https:\/\/www\.ruedesjoueurs\.com\/paris-sportifs\/le-petit-journal\/[^?#]+\.html$/.test(url)) return false;
  const match = /-(\d{1,2})-(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)-(\d{4})\.html$/.exec(url);
  if (!match) return false;
  const months = 'janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre'.split(' ');
  return `${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}` === day;
}
function publisherImage(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\x00-\x1f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'img.ruedesjoueurs.com' &&
      !url.username && !url.password && !url.port && !url.hash &&
      !/bookmaker|\/promo\/|pixel|banner/i.test(url.pathname);
  } catch (_) { return false; }
}

function planPresentationBackfill(rows, facts) {
  if (!Array.isArray(rows) || !Array.isArray(facts)) fail('presentation_arrays_required');
  const identities = new Map();
  for (const fact of facts) {
    const key = `${fact.editionDate}|${fact.sourceId}`;
    if (identities.has(key)) fail('presentation_duplicate_fact');
    identities.set(key, fact);
  }
  const operations = [];
  for (const row of rows) {
    const fact = identities.get(`${row.editionDate}|${row.sourceId}`);
    if (!fact) continue;
    if (row.source !== 'rdj_petit_journal' || row.kind !== 'article' || row.isPublished !== true ||
        row.payload?.source !== row.source || row.payload?.kind !== row.kind ||
        row.payload?.editionDate !== row.editionDate || row.payload?.sourceId !== row.sourceId)
      fail('presentation_existing_identity_mismatch');
    if (digest(row.payload) !== row.contentHash) fail('presentation_existing_hash_mismatch');
    const proof = fact.proof;
    if (!proof || proof.method !== 'dated-journal-card' || !/^[a-f\d]{64}$/.test(proof.sourceSha256 || '') ||
        !datedJournal(proof.journalUrl, row.editionDate) ||
        proof.editionDate !== row.editionDate || !Array.isArray(proof.participantLogos) || proof.participantLogos.length !== 2)
      fail('presentation_source_proof_required');
    const payload = copy(row.payload);
    const changed = [];
    if (fact.teams) {
      const teams = {};
      for (const [index, side] of ['home', 'away'].entries()) {
        const value = fact.teams[side];
        if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 180 ||
            !publisherImage(value.logo) || value.logo !== proof.participantLogos[index])
          fail('presentation_participant_proof_mismatch');
        const previous = payload.teams?.[side];
        if (previous?.name && previous.name !== value.name) fail('presentation_participant_name_conflict');
        if (previous?.logo && previous.logo !== value.logo) fail('presentation_participant_logo_conflict');
        teams[side] = { ...previous, name: value.name, logo: value.logo };
      }
      if (teams.home.name === teams.away.name) fail('presentation_duplicate_participant');
      if (JSON.stringify(payload.teams) !== JSON.stringify(teams)) {
        payload.teams = teams; changed.push('teams');
      }
    }
    if (fact.sourceTimeLabel !== undefined) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fact.sourceTimeLabel)) fail('presentation_clock_invalid');
      if (payload.sourceTimeLabel && payload.sourceTimeLabel !== fact.sourceTimeLabel) fail('presentation_clock_conflict');
      if (payload.sourceTimeLabel !== fact.sourceTimeLabel) {
        payload.sourceTimeLabel = fact.sourceTimeLabel; changed.push('sourceTimeLabel');
      }
    }
    if (fact.sport !== undefined) {
      if (fact.sport?.key !== 'football' || fact.sport?.name !== 'Football') fail('presentation_sport_invalid');
      if (payload.sport?.key && !['sport', 'football'].includes(payload.sport.key)) fail('presentation_sport_conflict');
      if (!payload.sport?.key || payload.sport.key === 'sport') {
        payload.sport = copy(fact.sport); changed.push('sport');
      }
    }
    if (fact.artworkUrl !== undefined) {
      if (!publisherImage(fact.artworkUrl) || !payload.teams) fail('presentation_artwork_invalid');
      if (payload.artworkUrl && payload.artworkUrl !== fact.artworkUrl) fail('presentation_artwork_conflict');
      if (payload.artworkUrl !== fact.artworkUrl) {
        payload.artworkUrl = fact.artworkUrl; changed.push('artworkUrl');
      }
    }
    if (changed.length) operations.push({
      updateOne: {
        filter: { _id: row._id, source: row.source, editionDate: row.editionDate,
          sourceId: row.sourceId, isPublished: true, contentHash: row.contentHash },
        update: { $set: { payload, contentHash: digest(payload) } },
      },
      changed,
    });
  }
  return operations;
}

module.exports = { planPresentationBackfill, digest };
