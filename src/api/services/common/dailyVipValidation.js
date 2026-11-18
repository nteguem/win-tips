const { failure } = require('./editorialSources');
const { editionDateFor } = require('./editorialCalendar');

const SOURCE = 'wintips_daily_vip';
const INDEX_URL = 'https://www.sportytrader.com/pronostics/';
const POLICY = Object.freeze({ minTotalOdds: 3, targetMaxTotalOdds: 3.5, maxTotalOdds: 3.5 });
const SPORTS = ['football', 'tennis', 'basketball', 'volleyball', 'handball', 'rugby', 'ice_hockey', 'baseball', 'american_football'];
const MARKETS = ['match_winner', 'over_under_goals', 'btts', 'double_chance', 'draw_no_bet',
  'handicap', 'over_under_points', 'over_under_games', 'player_points', 'combined_market'];
function keys(value, names, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key)))
    throw failure(`Champ invalide dans ${field}`);
}
function text(value, field, max = 220) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw failure(`${field} invalide`);
  return value.trim();
}
function bilingual(value, field, max = 220, empty = false) {
  keys(value, ['fr', 'en'], field);
  return Object.fromEntries(['fr', 'en'].map(lang => [lang, empty && value[lang] === '' ? '' : text(value[lang], `${field}.${lang}`, max)]));
}
function instant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw failure(`${field} invalide`);
  const iso = new Date(value).toISOString();
  if (iso.slice(0, 10) !== value.slice(0, 10)) throw failure(`${field} invalide`);
  return iso;
}
function sourceUrl(value, section = null) {
  let url;
  try { url = new URL(value); } catch (_) { throw failure('URL SportyTrader invalide'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.sportytrader.com' || url.username || url.password || url.port || url.search || url.hash ||
      (section ? !new RegExp(`^/${section}/[a-z0-9-]+-\\d+/$`).test(url.pathname) : url.href !== INDEX_URL)) throw failure('Une URL canonique SportyTrader est requise');
  return url.href;
}
function sourceLogo(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw failure('Logo invalide'); }
  // Display assets use the same trusted hosts for teams and competitions.
  if (url.protocol !== 'https:' || !['www.sportytrader.com', 'static.sportytrader.com', 'cdn.sportytrader.com', 'flagcdn.com'].includes(url.hostname) || url.username || url.password || url.port || url.hash) throw failure('Logo source invalide');
  return url.href;
}
function optionalText(value, field, max) {
  try { return text(value, field, max); } catch (_) { return undefined; }
}
function optionalCountryCode(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : undefined;
}
function optionalLogo(value) {
  try { return sourceLogo(value); } catch (_) { return undefined; }
}
function competition(input) {
  // Presentation is optional: a missing breadcrumb, flag or asset must not
  // discard an otherwise verified event. Persist only the known safe fields.
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  const name = optionalText(input.name, 'competition.name', 180);
  const country = optionalText(input.country, 'competition.country', 100);
  const countryCode = optionalCountryCode(input.countryCode);
  const logo = optionalLogo(input.logo);
  if (name !== undefined) out.name = name;
  if (logo !== undefined) out.logo = logo;
  if (input.scope === 'international') {
    out.scope = 'international';
    // An international competition cannot also claim a domestic flag. Keep
    // the unambiguous scope and omit contradictory country presentation.
    if (country && /^international$/i.test(country)) out.country = country;
  } else {
    if (country !== undefined) out.country = country;
    if (countryCode !== undefined) out.countryCode = countryCode;
    if (input.scope === 'national') out.scope = 'national';
  }
  return out;
}
function team(input, name) {
  keys(input, ['name', 'logo', 'countryCode'], name);
  const out = { name: text(input.name, `${name}.name`, 180) };
  const countryCode = optionalCountryCode(input.countryCode);
  const logo = optionalLogo(input.logo);
  if (countryCode !== undefined) out.countryCode = countryCode;
  if (logo !== undefined) out.logo = logo;
  return out;
}
function normalizeDailyVip(input, editionDate) {
  const normalize = (value, leg = false) => {
    keys(value, ['source', 'sourceId', 'sourceUrl', 'editionDate', 'kind', 'title', 'summary', 'startsAtUtc', 'sport', 'competition', 'teams', 'analysis', 'selection', 'legs', 'status', ...(leg ? ['provenance'] : ['dailyVip'])], leg ? 'leg' : 'coupon');
    if (value.source !== undefined && value.source !== SOURCE || value.editionDate !== undefined && value.editionDate !== editionDate || value.kind !== (leg ? 'match' : 'combine') || value.status !== 'upcoming') throw failure('Identite du combine du jour incoherente');
    const sourceId = text(value.sourceId, 'sourceId');
    if (leg ? !/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(sourceId) : sourceId !== `daily-vip-${editionDate}`) throw failure('Identite quotidienne requise');
    const out = { source: SOURCE, editionDate, sourceId, sourceUrl: sourceUrl(value.sourceUrl, leg ? 'pronostics' : null), kind: value.kind,
      title: bilingual(value.title, 'title'), summary: bilingual(value.summary || { fr: '', en: '' }, 'summary', 700, true),
      startsAtUtc: instant(value.startsAtUtc, 'startsAtUtc'), status: 'upcoming' };
    if (editionDateFor(out.startsAtUtc) !== editionDate) throw failure('Rencontre hors edition du jour');
    keys(value.sport, ['key', 'name', 'icon'], 'sport');
    if (!(leg ? SPORTS : ['multisport', ...SPORTS]).includes(value.sport.key)) throw failure('Sport du combine inconnu');
    out.sport = { key: value.sport.key, name: text(value.sport.name, 'sport.name', 80) };
    out.competition = competition(value.competition);
    if (value.analysis !== undefined && (JSON.stringify(value.analysis) !== '{"fr":[],"en":[]}' && JSON.stringify(value.analysis) !== '{"en":[],"fr":[]}')) throw failure('Le combine contient des selections, pas un article');
    out.analysis = { fr: [], en: [] };
    keys(value.selection, ['betType', 'label', ...(leg ? ['odds'] : ['totalOdds'])], 'selection');
    out.selection = { betType: text(value.selection.betType, 'betType', 80), label: bilingual(value.selection.label, 'selection.label', 300) };
    const oddsKey = leg ? 'odds' : 'totalOdds', odd = value.selection[oddsKey];
    if (typeof odd !== 'number' || !Number.isFinite(odd) || odd <= 1 || odd > 100 || Math.abs(odd * 100 - Math.round(odd * 100)) > 0.000001) throw failure('Cote source decimale invalide');
    out.selection[oddsKey] = odd;
    if (leg) {
      if (!MARKETS.includes(out.selection.betType)) throw failure('Marche non pris en charge par ce collecteur');
      keys(value.teams, ['home', 'away'], 'teams');
      out.teams = { home: team(value.teams.home, 'home'), away: team(value.teams.away, 'away') };
      if (out.teams.home.name.toLowerCase() === out.teams.away.name.toLowerCase()) throw failure('Deux participants distincts requis');
      keys(value.provenance, ['predictionUrl', 'oddsUrl', 'observedAtUtc', 'market', 'eventClockSourceUrl'], 'provenance');
      const predictionUrl = sourceUrl(value.provenance.predictionUrl, 'pronostics');
      if (predictionUrl !== out.sourceUrl) throw failure('Source de selection incoherente');
      const oddsUrl = sourceUrl(value.provenance.oddsUrl, 'cotes');
      const eventClockSourceUrl = value.provenance.eventClockSourceUrl;
      if (![predictionUrl, oddsUrl].includes(eventClockSourceUrl)) throw failure('Source horaire incoherente');
      out.provenance = { predictionUrl, oddsUrl, observedAtUtc: instant(value.provenance.observedAtUtc, 'observedAtUtc'),
        market: text(value.provenance.market, 'provenance.market', 300), eventClockSourceUrl };
      if (Date.parse(out.provenance.observedAtUtc) >= Date.parse(out.startsAtUtc)) throw failure('Cote observee apres le depart');
      return out;
    }
    if (out.selection.betType !== 'accumulator' || !Array.isArray(value.legs) || value.legs.length < 2 || value.legs.length > 3) throw failure('Deux ou trois selections sont requises');
    out.legs = value.legs.map(item => normalize(item, true));
    const eventIdentity = item => [item.teams.home.name.toLowerCase(), item.teams.away.name.toLowerCase()].sort().join('|') + '|' + item.startsAtUtc;
    if (new Set(out.legs.map(item => item.sourceId)).size !== out.legs.length || new Set(out.legs.map(eventIdentity)).size !== out.legs.length) throw failure('Evenement duplique');
    if (Date.parse(out.startsAtUtc) !== Math.min(...out.legs.map(item => Date.parse(item.startsAtUtc)))) throw failure('Depart du combine incoherent');
    const numerator = out.legs.reduce((total, item) => total * Math.round(item.selection.odds * 100), 1);
    const denominator = 100 ** out.legs.length;
    const product = Math.round(numerator / denominator * 100) / 100;
    if (product !== odd || numerator < POLICY.minTotalOdds * denominator || numerator > POLICY.maxTotalOdds * denominator) throw failure('La cote combinee doit etre le produit des cotes entre 3 et 3,5');
    keys(value.dailyVip, ['version', 'publisher', 'bookmaker', 'observedAtUtc', 'policy', 'result'], 'dailyVip');
    keys(value.dailyVip.policy, Object.keys(POLICY), 'policy');
    if (value.dailyVip.version !== 1 || value.dailyVip.publisher !== 'SportyTrader' || Object.entries(POLICY).some(([key, expected]) => value.dailyVip.policy[key] !== expected)) throw failure('Politique quotidienne invalide');
    keys(value.dailyVip.result, ['status'], 'result');
    if (value.dailyVip.result.status !== 'pending') throw failure('Le resultat initial doit rester a suivre');
    const observedAtUtc = instant(value.dailyVip.observedAtUtc, 'dailyVip.observedAtUtc');
    if (Date.parse(observedAtUtc) !== Math.max(...out.legs.map(item => Date.parse(item.provenance.observedAtUtc)))) throw failure('Date de releve incoherente');
    out.dailyVip = { version: 1, publisher: 'SportyTrader', bookmaker: text(value.dailyVip.bookmaker, 'bookmaker', 80), observedAtUtc,
      policy: { ...POLICY }, result: { status: 'pending' } };
    return out;
  };
  return normalize(input);
}
function validateObservationTime(item, now) {
  for (const leg of item.legs) {
    const observed = Date.parse(leg.provenance.observedAtUtc);
    if (observed > now.getTime() + 300000 || observed < now.getTime() - 3 * 3600000) throw failure('Les cotes doivent etre relevees depuis moins de trois heures');
  }
}
function publicMetadata(item) {
  return { version: 1, bookmaker: item.dailyVip.bookmaker, observedAtUtc: item.dailyVip.observedAtUtc,
    policy: { ...POLICY }, result: { status: 'pending' }, totalOdds: item.selection.totalOdds };
}
module.exports = { SOURCE, INDEX_URL, POLICY, normalizeDailyVip, validateObservationTime, sourceUrl, publicMetadata };
