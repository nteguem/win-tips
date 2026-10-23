const { sourceByKey, validatePublisherUrl, failure } = require('./editorialSources');
const { editionDateFor } = require('./editorialCalendar');

const KINDS = ['match', 'horse_racing', 'combine'];
const STATUSES = ['upcoming', 'started', 'finished', 'cancelled', 'unknown'];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`${name} doit etre un objet`);
  return value;
}
function text(value, name, max = 500, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw failure(`${name} invalide`);
  return value.trim();
}
function keys(value, allowed, name) {
  object(value, name);
  if (Object.keys(value).some(k => !allowed.includes(k))) throw failure(`Champ non autorise dans ${name}`);
}
function i18n(value, name, max, optional = false) {
  if (!value && optional) return { fr: '' };
  keys(value, ['fr', 'en'], name);
  const out = { fr: text(value.fr, `${name}.fr`, max, optional) };
  if (value.en !== undefined && value.en !== '') out.en = text(value.en, `${name}.en`, max);
  return out;
}
function integer(value, name, max = 100000, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (!Number.isInteger(value) || value < 1 || value > max) throw failure(`${name} invalide`);
  return value;
}
function odds(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 100000) throw failure(`${name} invalide`);
  return value;
}
function image(value, name) {
  if (!value) return undefined;
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw failure(`${name} invalide`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port) throw failure(`${name} doit etre une URL HTTPS`);
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(parsed.hostname) || parsed.hostname.includes(':') || parsed.hostname.endsWith('.local')) throw failure(`${name} ne doit pas viser un reseau prive`);
  return parsed.href;
}
function dateOnly(value, name = 'editionDate') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw failure(`${name} invalide`);
  return value;
}
function timestamp(value, editionDate, required = false) {
  if (value === null || value === undefined) {
    if (required) throw failure('Heure verifiee requise pour un combine');
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) throw failure('startsAtUtc invalide');
  dateOnly(value.slice(0, 10), 'startsAtUtc');
  const iso = new Date(value).toISOString();
  if (editionDateFor(iso) !== editionDate) throw failure('La rencontre ne correspond pas a la date Europe/Paris de cette edition');
  return iso;
}
function analysis(value) {
  keys(value, ['fr', 'en'], 'analysis');
  const out = {};
  for (const lang of ['fr', 'en']) {
    const sections = value[lang];
    if (lang === 'en' && sections === undefined) continue;
    if (!Array.isArray(sections) || sections.length < 1 || sections.length > 16) throw failure(`analysis.${lang} invalide`);
    out[lang] = sections.map(section => {
      keys(section, ['heading', 'paragraphs'], 'section');
      if (!Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.length > 20) throw failure('Paragraphes invalides');
      return { heading: text(section.heading, 'heading', 180), paragraphs: section.paragraphs.map(p => text(p, 'paragraph', 6000)) };
    });
  }
  return out;
}
function selection(value) {
  keys(value, ['label', 'odds', 'betType', 'orderedNumbers', 'totalOdds'], 'selection');
  const out = { label: i18n(value.label, 'selection.label', 500), odds: odds(value.odds, 'odds'), totalOdds: odds(value.totalOdds, 'totalOdds') };
  if (value.betType) out.betType = text(value.betType, 'betType', 80);
  if (value.orderedNumbers !== undefined) {
    if (!Array.isArray(value.orderedNumbers) || value.orderedNumbers.length > 30) throw failure('orderedNumbers invalide');
    out.orderedNumbers = value.orderedNumbers.map(n => integer(n, 'numero', 99));
    if (new Set(out.orderedNumbers).size !== out.orderedNumbers.length) throw failure('Numeros dupliques dans la selection');
  }
  return out;
}
function team(value, name) {
  keys(value, ['name', 'logo'], name);
  return { name: text(value.name, `${name}.name`, 180), ...(value.logo ? { logo: image(value.logo, `${name}.logo`) } : {}) };
}
function verifyIdentity(item, leg) {
  const url = new URL(item.sourceUrl);
  if (item.kind === 'horse_racing') {
    const route = url.pathname.match(/\/course\/(\d{2})-(\d{2})-(\d{4})\/R(\d+)\/C(\d+)\//);
    if (!route || `${route[3]}-${route[2]}-${route[1]}` !== item.editionDate || Number(route[4]) !== item.race.meetingNumber || Number(route[5]) !== item.race.raceNumber || item.sourceId !== `${item.editionDate}-R${Number(route[4])}C${Number(route[5])}`) throw failure('Identite ou date de course incoherente avec la fiche RDJ');
  } else if (leg || item.source === 'rdj_football_analysis') {
    const publisherId = url.pathname.match(/-(\d+)\.html$/);
    if (!publisherId || publisherId[1] !== item.sourceId) throw failure('Identifiant de rencontre incoherent avec la fiche RDJ');
  } else if (item.kind === 'combine') {
    const publisherId = url.pathname.match(/\/(\d+)-[^/]+\.html$/);
    if (!publisherId || publisherId[1] !== item.sourceId) throw failure('Identifiant du combine incoherent avec son article RDJ');
    const dateInUrl = url.pathname.match(/(\d{2})-(\d{2})-(\d{4})(?=\D|$)/);
    if (dateInUrl && `${dateInUrl[3]}-${dateInUrl[2]}-${dateInUrl[1]}` !== item.editionDate) throw failure('Cet article combine correspond a une autre edition');
  } else {
    if (!/^\d+$/.test(item.sourceId)) throw failure('Identifiant de rencontre RDJ requis');
    const numericDate = url.pathname.match(/(\d{2})-(\d{2})-(\d{4})(?=\D|$)/);
    const months = { janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06', juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12' };
    const frenchDate = url.pathname.match(/(?:^|-)(\d{1,2})(?:er)?-(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:-(\d{4}))?(?=-|\.html|$)/i);
    const explicitDates = [numericDate ? `${numericDate[3]}-${numericDate[2]}-${numericDate[1]}` : null,
      frenchDate ? `${frenchDate[3] || item.editionDate.slice(0, 4)}-${months[frenchDate[2].toLowerCase()]}-${frenchDate[1].padStart(2, '0')}` : null].filter(Boolean);
    if (explicitDates.some(date => date !== item.editionDate)) throw failure('Le Petit Journal indique une autre date dans son URL');
  }
}
function normalizeItem(input, source, editionDate, leg = false) {
  keys(input, ['source', 'sourceId', 'sourceUrl', 'editionDate', 'kind', 'title', 'summary', 'startsAtUtc', 'sport', 'competition', 'teams', 'race', 'analysis', 'selection', 'legs', 'status'], 'item');
  if (input.source !== undefined && input.source !== source) throw failure('Source incoherente dans item');
  if (input.editionDate !== undefined && input.editionDate !== editionDate) throw failure('Date incoherente dans item');
  const info = sourceByKey(source);
  if (!info || !KINDS.includes(input.kind) || (leg ? input.kind !== 'match' : !info.kinds.includes(input.kind))) throw failure('Type de contenu incompatible avec la source');
  const normalized = {
    source, editionDate,
    sourceId: text(input.sourceId, 'sourceId', 220),
    sourceUrl: leg ? validatePublisherUrl(input.sourceUrl, 'rdj_football_analysis') : validatePublisherUrl(input.sourceUrl, source),
    kind: input.kind, title: i18n(input.title, 'title', 220), summary: i18n(input.summary, 'summary', 700, true),
    startsAtUtc: timestamp(input.startsAtUtc, editionDate, leg),
    analysis: analysis(input.analysis), selection: selection(input.selection),
    status: input.status || 'unknown',
  };
  if (!STATUSES.includes(normalized.status)) throw failure('Statut de rencontre inconnu');
  keys(input.sport, ['key', 'name', 'icon'], 'sport');
  normalized.sport = { key: text(input.sport.key, 'sport.key', 50), name: text(input.sport.name, 'sport.name', 80) };
  if (input.sport.icon) normalized.sport.icon = text(input.sport.icon, 'sport.icon', 200);
  if (input.competition) {
    keys(input.competition, ['name', 'country', 'countryCode', 'logo'], 'competition');
    normalized.competition = { name: text(input.competition.name, 'competition.name', 180) };
    if (input.competition.country) normalized.competition.country = text(input.competition.country, 'competition.country', 100);
    if (input.competition.countryCode) {
      if (!/^[A-Z]{2}$/.test(input.competition.countryCode)) throw failure('countryCode invalide');
      normalized.competition.countryCode = input.competition.countryCode;
    }
    if (input.competition.logo) normalized.competition.logo = image(input.competition.logo, 'competition.logo');
  }
  if (input.kind === 'match') {
    keys(input.teams, ['home', 'away'], 'teams');
    normalized.teams = { home: team(input.teams.home, 'home'), away: team(input.teams.away, 'away') };
    if (!normalized.competition) throw failure('Competition requise');
    if (source.startsWith('rdj_football') && normalized.sport.key !== 'football') throw failure('Sport incompatible avec cette source football');
  } else if (input.kind === 'horse_racing') {
    if (normalized.sport.key !== 'horse_racing') throw failure('Sport hippique requis');
    const race = input.race;
    keys(race, ['meetingNumber', 'raceNumber', 'name', 'racecourse', 'discipline', 'distanceMeters', 'runnersCount', 'runners'], 'race');
    if (!Array.isArray(race.runners) || !race.runners.length || race.runners.length > 50) throw failure('Partants requis');
    normalized.race = {
      meetingNumber: integer(race.meetingNumber, 'meetingNumber', 99), raceNumber: integer(race.raceNumber, 'raceNumber', 99),
      name: text(race.name, 'race.name', 200), racecourse: text(race.racecourse, 'racecourse', 160), discipline: text(race.discipline, 'discipline', 100),
      distanceMeters: integer(race.distanceMeters, 'distanceMeters', 20000), runnersCount: integer(race.runnersCount, 'runnersCount', 50),
      runners: race.runners.map(runner => {
        keys(runner, ['number', 'name', 'jockey', 'trainer', 'silksUrl', 'odds'], 'runner');
        const out = { number: integer(runner.number, 'runner.number', 99), name: text(runner.name, 'runner.name', 160), odds: odds(runner.odds, 'runner.odds') };
        for (const key of ['jockey', 'trainer']) if (runner[key]) out[key] = text(runner[key], key, 160);
        if (runner.silksUrl) out.silksUrl = image(runner.silksUrl, 'silksUrl');
        return out;
      }),
    };
    const numbers = new Set(normalized.race.runners.map(r => r.number));
    if (numbers.size !== normalized.race.runners.length || normalized.race.runnersCount < numbers.size) throw failure('Partants incoherents');
    if (!normalized.selection.orderedNumbers || !normalized.selection.orderedNumbers.length || normalized.selection.orderedNumbers.some(n => !numbers.has(n))) throw failure('Selection hippique incoherente avec les partants');
  } else {
    if (normalized.sport.key !== 'football' || !Array.isArray(input.legs) || input.legs.length < 2 || input.legs.length > 12) throw failure('Un combine requiert au moins deux rencontres football explicites');
    normalized.legs = input.legs.map(item => normalizeItem(item, source, editionDate, true));
    if (new Set(normalized.legs.map(item => item.sourceId)).size !== normalized.legs.length) throw failure('Rencontre dupliquee dans le combine');
    // A combined price is supplied by the publisher, never calculated here.
  }
  verifyIdentity(normalized, leg);
  return normalized;
}
function validateBatch(body, now = new Date()) {
  keys(body, ['source', 'editionDate', 'items'], 'batch');
  const source = sourceByKey(body.source);
  if (!source) throw failure('Source editoriale inconnue');
  const editionDate = dateOnly(body.editionDate);
  if (editionDate !== editionDateFor(now)) throw failure('Seule une edition du jour Europe/Paris peut etre importee');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw failure('Le lot doit contenir entre 1 et 50 contenus');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 2 * 1024 * 1024) throw failure('Lot editorial trop volumineux');
  const items = body.items.map(item => normalizeItem(item, source.key, editionDate));
  const earliest = now.getTime() + 30 * 60 * 1000;
  for (const item of items) {
    const events = item.kind === 'combine' ? item.legs : [item];
    for (const event of events) {
      if (!event.startsAtUtc || new Date(event.startsAtUtc).getTime() < earliest || event.status !== 'upcoming') throw failure('Publication requise au moins 30 minutes avant chaque depart verifie');
    }
    if (item.kind === 'combine' && (item.status !== 'upcoming' || (item.startsAtUtc && new Date(item.startsAtUtc).getTime() < earliest))) throw failure('Combine deja commence ou trop proche du coup d envoi');
    if (item.kind === 'combine' && item.startsAtUtc && new Date(item.startsAtUtc).getTime() !== Math.min(...item.legs.map(leg => new Date(leg.startsAtUtc).getTime()))) throw failure('Le depart du combine doit correspondre a sa premiere rencontre');
  }
  if (new Set(items.map(item => item.sourceId)).size !== items.length) throw failure('sourceId duplique dans le lot');
  return { source: source.key, editionDate, items };
}

function hasCompleteEnglish(item) {
  const numbers = value => JSON.stringify((String(value).match(/[+-]?\d+(?:[.,]\d+)?/g) || []).map(v => v.replace(',', '.')).sort());
  const translated = value => value && typeof value.en === 'string' && value.en.trim() && numbers(value.fr) === numbers(value.en);
  if (!translated(item.title) || (item.summary && item.summary.fr && !translated(item.summary)) || !translated(item.selection && item.selection.label)) return false;
  const fr = item.analysis && item.analysis.fr, en = item.analysis && item.analysis.en;
  if (!Array.isArray(fr) || !Array.isArray(en) || fr.length !== en.length) return false;
  if (!fr.every((section, index) => {
    const other = en[index];
    return other && typeof other.heading === 'string' && other.heading.trim() && numbers(section.heading) === numbers(other.heading) &&
      Array.isArray(other.paragraphs) && section.paragraphs.length === other.paragraphs.length &&
      section.paragraphs.every((p, i) => typeof other.paragraphs[i] === 'string' && other.paragraphs[i].trim() && numbers(p) === numbers(other.paragraphs[i]));
  })) return false;
  return !item.legs || item.legs.every(hasCompleteEnglish);
}
function requireCompleteEnglish(items) {
  if (!items.every(hasCompleteEnglish)) throw failure('Traduction anglaise complete et coherente requise avant publication');
}

module.exports = { validateBatch, normalizeItem, dateOnly, hasCompleteEnglish, requireCompleteEnglish };
