// Authoritative Duo/Goals identity. Never trusts a worker-supplied fingerprint.
const crypto = require('crypto');
const { failure, validatePublisherUrl } = require('./editorialSources');
const TICKET_SOURCES = ['rdj_football_duo', 'rdj_football_goals'];
const VERSION = 'rdj-ticket-v1';
const fold = value => String(value).replace(/[\u2013\u2014]/g, '-').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase();
const compact = value => fold(value).replace(/[^a-z0-9]/g, '');
// Same finite football aliases as the existing official-schedule adapter.
const GROUPS = [
  ['rennes','stade rennais','stade rennais fc'],['marseille','om','olympique de marseille'],['lyon','ol','olympique lyonnais'],['paris saint-germain','psg'],['monaco','as monaco'],['nice','ogc nice'],['lens','rc lens'],['lille','losc lille','lille osc'],['toulouse','toulouse fc'],['angers','angers sco'],['auxerre','aj auxerre'],['nantes','fc nantes'],['le havre','le havre ac'],['lorient','fc lorient'],['montpellier','montpellier hsc'],['reims','stade de reims'],['metz','fc metz'],['strasbourg','rc strasbourg','rc strasbourg alsace'],
  ['nancy','as nancy lorraine'],['laval','stade laval','stade lavallois','stade lavallois mayenne fc'],['clermont','clermont foot','clermont foot 63'],['guingamp','ea guingamp','en avant guingamp'],['dunkerque','usl dunkerque'],['grenoble','grenoble foot 38'],['pau','pau fc'],['annecy','fc annecy'],['sochaux','fc sochaux','fc sochaux-montbeliard'],['bastia','sc bastia'],['rodez','rodez aveyron'],['red star','red star fc'],
  ['tottenham','tottenham hotspur'],['wolverhampton','wolverhampton wanderers','wolves'],['nottingham forest','nottingham'],['manchester city','man city'],['manchester united','man united','manu'],['newcastle','newcastle united'],['leeds','leeds united'],['leicester','leicester city'],['brighton','brighton & hove albion'],['west ham','west ham united'],['bournemouth','afc bournemouth'],['athletic bilbao','athletic club'],['betis seville','real betis','betis'],['fc seville','seville','sevilla','sevilla fc'],['alaves','deportivo alaves'],['osasuna','ca osasuna'],['milan ac','ac milan','milan'],['juventus','juventus fc'],['inter milan','internazionale','inter'],['naples','ssc naples','napoli'],['atalanta','atalanta bergame'],['lazio','lazio rome'],['as rome','as roma','roma'],['hellas verone','hellas verona'],['bayern munich','bayern munchen'],['mayence','mainz','mainz 05'],['fribourg','freiburg','sc freiburg'],['cologne','fc koln'],['hambourg','hamburger sv'],['st pauli','fc st pauli'],['union berlin','fc union berlin','1. fc union berlin'],['hoffenheim','tsg hoffenheim','tsg 1899 hoffenheim'],['leverkusen','bayer leverkusen','bayer 04 leverkusen'],['stuttgart','vfb stuttgart','stuttgat'],['borussia monchengladbach','m gladbach','mgladbach'],['como','come'],
];
const ALIASES = new Map(GROUPS.flatMap(group => group.map(name => [compact(name), compact(group[0])])));
const teamKey = value => ALIASES.get(compact(value)) || compact(value);
const decimal = value => value.replace(',', '.').replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
function bad() { throw failure('Composition du ticket non verifiable; revue requise', 409); }
function market(leg, participants) {
  const label = fold(leg.selection?.label?.fr || '').trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  let match, result;
  if ((match = /^(?:les 2|les deux) equipes marquent(?:\s*[:\-]\s*(oui|non))?$/.exec(label))) result = ['btts', match[1] === 'non' ? 'no' : 'yes'];
  else if ((match = /^(plus|moins|\+|-)\s*(?:de\s+)?(\d+(?:[.,]\d+)?) buts?(?:\s+(?:dans le match|au total))?$/.exec(label))) result = ['over_under_goals', ['plus','+'].includes(match[1]) ? 'over' : 'under', decimal(match[2])];
  else if ((match = /^(plus|moins) de (\d+(?:[.,]\d+)?) buts? (?:pour|de) (.+)$/.exec(label))) result = ['team_goals', teamKey(match[3]), match[1] === 'plus' ? 'over' : 'under', decimal(match[2])];
  else if ((match = /^victoire (?:de )?(.+)$/.exec(label))) result = ['match_winner', teamKey(match[1])];
  else if (label === 'match nul') result = ['draw'];
  else bad();
  if (result[0] !== leg.selection.betType || (['team_goals','match_winner'].includes(result[0]) && !participants.includes(result[1]))) bad();
  return result;
}
function ticketFingerprint(item) {
  if (item?.kind !== 'combine' || !Array.isArray(item.legs) || item.legs.length < 2 || item.legs.length > 3) bad();
  const legs = item.legs.map(leg => {
    const participants = ['home','away'].map(side => teamKey(leg.teams?.[side]?.name || ''));
    const start = new Date(leg.startsAtUtc);
    if (participants.some(name => !name) || participants[0] === participants[1] || typeof leg.startsAtUtc !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(leg.startsAtUtc) || !Number.isFinite(start.getTime()) || start.getUTCMilliseconds()) bad();
    return [start.toISOString().replace('.000Z','Z'), ...participants, ...market(leg, participants)];
  });
  legs.sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  if (new Set(legs.map(leg => JSON.stringify(leg.slice(0,3)))).size !== legs.length) bad();
  return crypto.createHash('sha256').update(JSON.stringify([VERSION, legs])).digest('hex');
}
function emptyState(editionDate) { return { version: VERSION, editionDate, duo: null, goals: [] }; }
function reserve(state, source, entry) {
  if (!TICKET_SOURCES.includes(source) || !entry || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !/^\d+$/.test(entry.sourceId) || typeof entry.sourceUrl !== 'string') bad();
  let url;
  try { url = new URL(validatePublisherUrl(entry.sourceUrl, source)); } catch (_) { bad(); }
  if (url.pathname.match(/\/(\d+)-[^/]+\.html$/)?.[1] !== entry.sourceId) bad();
  const date = url.pathname.match(/(\d{2})-(\d{2})-(\d{4})(?=\D|$)/);
  if (date && `${date[3]}-${date[2]}-${date[1]}` !== state.editionDate) bad();
  const other = source === TICKET_SOURCES[0] ? state.goals : (state.duo ? [state.duo] : []);
  if (other.some(row => row.fingerprint === entry.fingerprint || row.sourceId === entry.sourceId || row.sourceUrl === entry.sourceUrl)) throw failure('Ce ticket appartient deja a une autre rubrique de cette edition', 409);
  const own = source === TICKET_SOURCES[0] ? (state.duo ? [state.duo] : []) : state.goals;
  if (own.some(row => (row.sourceId === entry.sourceId || row.sourceUrl === entry.sourceUrl) && row.fingerprint !== entry.fingerprint)) throw failure('La composition du ticket publie doit etre conservee', 409);
  const prior = own.find(row => row.fingerprint === entry.fingerprint);
  if ((source === TICKET_SOURCES[0] && own.length && !prior) || (prior && (prior.sourceId !== entry.sourceId || prior.sourceUrl !== entry.sourceUrl))) throw failure('Le ticket publie de cette edition doit conserver son identite', 409);
  if (!prior) {
    if (source === TICKET_SOURCES[0]) state.duo = entry;
    else state.goals.push(entry);
  }
  if (state.goals.length > 50) bad();
  return state;
}
function entryFor(item) { return { fingerprint: ticketFingerprint(item), sourceId: item.sourceId, sourceUrl: item.sourceUrl }; }
function mergeState(editionDate, stored, rows) {
  const state = emptyState(editionDate);
  if (stored) {
    if (stored.version !== VERSION || stored.editionDate !== editionDate || !Array.isArray(stored.goals)) bad();
    if (stored.duo) reserve(state, TICKET_SOURCES[0], stored.duo);
    for (const entry of stored.goals) reserve(state, TICKET_SOURCES[1], entry);
  }
  for (const row of rows) {
    if (row.editionDate !== editionDate || row.sourceId !== row.payload?.sourceId) bad();
    reserve(state, row.source, entryFor(row.payload));
  }
  return state;
}
module.exports = { VERSION, TICKET_SOURCES, teamKey, ticketFingerprint, emptyState, reserve, entryFor, mergeState };
