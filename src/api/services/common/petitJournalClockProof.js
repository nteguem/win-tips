// A dated Petit Journal owns its complete next-day programme. This proof is
// accepted only by the authenticated editorial importer, never by VIP sources.
const { failure, validatePublisherUrl } = require('./editorialSources');

const MONTHS = { janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06',
  juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12' };
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/;

function checked(value) { if (!value) throw failure('Preuve horaire du Petit Journal incoherente'); }
function exactKeys(value, allowed) {
  checked(value && typeof value === 'object' && !Array.isArray(value));
  checked(Object.keys(value).every(key => allowed.includes(key)));
}
function wallTime(value) {
  checked(typeof value === 'string');
  const match = CLOCK.exec(value);
  checked(match && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4] || 0) < 60);
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4] || '00'}${match[5] || ''}`;
  const ms = Date.parse(iso + 'Z');
  checked(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === match[1]);
  return { ms, zone: match[6], raw: iso };
}
function parisWall(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
}
function clockMatches(value, instant) {
  const parsed = wallTime(value);
  return parsed.zone ? Date.parse(value) === instant : [instant, parisWall(instant)].includes(parsed.ms);
}
function journalDate(url) {
  const match = new URL(url).pathname.match(/\/\d+-[\w-]+-(\d{1,2})(?:er)?-(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)-(\d{4})\.html$/i);
  checked(match);
  const result = `${match[3]}-${MONTHS[match[2].toLowerCase()]}-${match[1].padStart(2, '0')}`;
  checked(new Date(result + 'T00:00:00Z').toISOString().slice(0, 10) === result);
  return result;
}
function rawCalendarDate(raw) {
  const text = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const dates = new Set();
  for (const match of text.matchAll(/\b(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})\b/g))
    dates.add(`${match[3]}-${MONTHS[match[2]]}-${match[1].padStart(2, '0')}`);
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g))
    dates.add(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  checked(dates.size === 1);
  return [...dates][0];
}
function normalization(value, proof, item) {
  exactKeys(value, ['method', 'source_url', 'raw', 'reference', 'normalized', 'candidates']);
  checked(value.method === 'rdj_24h_corroborated_v1' && value.reference === proof.journalClock && value.normalized === proof.detailClock);
  checked(typeof value.raw === 'string' && value.raw.length <= 500 && /(?<!\d)24\s*[:h]\s*[0-5]\d(?!\d)/i.test(value.raw));
  const url = validatePublisherUrl(value.source_url, 'rdj_football_analysis');
  checked(new RegExp(`-${item.sourceId}\\.html$`).test(new URL(url).pathname));
  checked(Array.isArray(value.candidates) && value.candidates.length === 2);
  const candidates = value.candidates.map(wallTime);
  checked(candidates.every(row => !row.zone && /T00:/.test(row.raw)) && candidates[1].ms - candidates[0].ms === 86400000);
  const rawMinutes = [...value.raw.matchAll(/(?<!\d)24\s*[:h]\s*([0-5]\d)(?!\d)/gi)].map(match => Number(match[1]));
  checked(rawMinutes.length === 1 && new Date(candidates[0].ms).toISOString().slice(0, 10) === rawCalendarDate(value.raw));
  checked(candidates.every(row => new Date(row.ms).getUTCMinutes() === rawMinutes[0] && new Date(row.ms).getUTCSeconds() === 0 && row.ms % 1000 === 0));
  checked(value.candidates.includes(value.normalized));
  return { ...value, candidates: [...value.candidates] };
}
function normalizePetitJournalClockProof(input, item) {
  checked(item.source === 'rdj_petit_journal' && item.kind === 'match' && input.editionConvention === 'journal_following_day');
  const proof = input.scheduleProof;
  exactKeys(proof, ['sourceUrl', 'sourceId', 'method', 'provider', 'editionDate', 'matchedParticipants',
    'startsAtUtc', 'status', 'journalClock', 'detailClock', 'normalization']);
  checked(proof.method === 'rdj_journal_clock' && proof.provider === 'rdj' && proof.editionDate === item.editionDate
    && proof.status === 'upcoming' && proof.sourceId === item.sourceId && /^\d{1,20}$/.test(proof.sourceId));
  const url = validatePublisherUrl(proof.sourceUrl, 'rdj_petit_journal');
  checked(url === item.sourceUrl && journalDate(url) === item.editionDate);
  const instant = Date.parse(item.startsAtUtc);
  checked(Number.isFinite(instant) && typeof proof.startsAtUtc === 'string' && CLOCK.test(proof.startsAtUtc)
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(proof.startsAtUtc) && Date.parse(proof.startsAtUtc) === instant);
  const next = new Date(Date.parse(item.editionDate + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  checked(new Date(parisWall(instant)).toISOString().slice(0, 10) === next);
  checked(Array.isArray(proof.matchedParticipants) && proof.matchedParticipants.length === 2
    && proof.matchedParticipants.every((name, index) => name === item.teams[index ? 'away' : 'home'].name));
  checked(clockMatches(proof.journalClock, instant) && clockMatches(proof.detailClock, instant));
  const out = { ...proof, sourceUrl: url, startsAtUtc: item.startsAtUtc, matchedParticipants: [...proof.matchedParticipants] };
  if (proof.normalization !== undefined) out.normalization = normalization(proof.normalization, proof, item);
  return out;
}

module.exports = { normalizePetitJournalClockProof };
