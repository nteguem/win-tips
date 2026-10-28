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
  if (value.en !== undefined && value.en !== '') {
    try { out.en = text(value.en, `${name}.en`, max); }
    catch (_) { out.en = out.fr; }
  }
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
function nbaFollowingNight(iso, editionDate, input) {
  if (input?.sport?.key !== 'basketball' || String(input?.competition?.name || '').trim().toUpperCase() !== 'NBA') return false;
  const next = new Date(Date.parse(editionDate + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
  return editionDateFor(iso) === next && localHour < 12;
}
function timestamp(value, editionDate, required = false, input = null) {
  if (value === null || value === undefined) {
    if (required) throw failure('Heure verifiee requise pour un combine');
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) throw failure('startsAtUtc invalide');
  dateOnly(value.slice(0, 10), 'startsAtUtc');
  const iso = new Date(value).toISOString();
  if (editionDateFor(iso) !== editionDate && !nbaFollowingNight(iso, editionDate, input)) throw failure('La rencontre ne correspond pas a la date Europe/Paris de cette edition');
  return iso;
}
function overnightProof(input, item) {
  const overnight = !!item.startsAtUtc && editionDateFor(item.startsAtUtc) !== item.editionDate;
  if (!overnight) {
    if (input.editionConvention !== undefined || input.scheduleProof !== undefined) throw failure('La convention de nuit est reservee a une rencontre NBA du lendemain');
    return;
  }
  if (!nbaFollowingNight(item.startsAtUtc, item.editionDate, item) || input.editionConvention !== 'nba_following_night') throw failure('Convention NBA de nuit explicite requise');
  const proof = input.scheduleProof;
  keys(proof, ['sourceUrl', 'sourceId', 'method', 'provider', 'matchedParticipants', 'startsAtUtc', 'status'], 'scheduleProof');
  if (proof.status !== 'upcoming' || typeof proof.sourceId !== 'string' || !/^\d{1,20}$/.test(proof.sourceId) || typeof proof.startsAtUtc !== 'string' || Date.parse(proof.startsAtUtc) !== Date.parse(item.startsAtUtc)) throw failure('Preuve horaire NBA incoherente');
  if (!Array.isArray(proof.matchedParticipants) || proof.matchedParticipants.length !== 2 || !item.teams ||
    proof.matchedParticipants.some((name, index) => name !== item.teams[index === 0 ? 'home' : 'away'].name)) throw failure('Participants de la preuve NBA incoherents');
  let url;
  try { url = new URL(proof.sourceUrl); } catch (_) { throw failure('URL de preuve NBA invalide'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw failure('URL de preuve NBA invalide');
  const nba = url.hostname === 'cdn.nba.com' && url.pathname === '/static/json/staticData/scheduleLeagueV2_1.json' && !url.search;
  const espn = url.hostname === 'site.api.espn.com' && url.pathname === '/apis/site/v2/sports/basketball/nba/scoreboard' &&
    [...url.searchParams.keys()].length === 1 && /^\d{8}$/.test(url.searchParams.get('dates') || '');
  if ((!nba && !espn) || proof.method !== (nba ? 'official_schedule' : 'provider_schedule') || (proof.provider !== undefined && proof.provider !== (nba ? 'nba' : 'espn'))) throw failure('Fournisseur de preuve NBA non autorise');
  if (espn) {
    const compact = url.searchParams.get('dates'), date = dateOnly(`${compact.slice(0,4)}-${compact.slice(4,6)}-${compact.slice(6,8)}`);
    if (Math.abs(Date.parse(date) - Date.parse(item.editionDate)) > 86400000) throw failure('La preuve ESPN ne correspond pas a cette edition');
  }
  item.editionConvention = 'nba_following_night';
  item.scheduleProof = { sourceUrl: url.href, sourceId: proof.sourceId, method: proof.method,
    provider: nba ? 'nba' : 'espn', matchedParticipants: [...proof.matchedParticipants], startsAtUtc: item.startsAtUtc, status: 'upcoming' };
}
function analysis(value) {
  keys(value, ['fr', 'en'], 'analysis');
  const out = {};
  // The source is strictly validated. A malformed/overlong English candidate
  // falls back locally instead of turning a translation failure into an outage.
  const sections = value.fr;
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 16) throw failure('analysis.fr invalide');
  out.fr = sections.map(section => {
      keys(section, ['heading', 'paragraphs'], 'section');
      if (!Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.length > 20) throw failure('Paragraphes invalides');
      return { heading: text(section.heading, 'heading', 180), paragraphs: section.paragraphs.map(p => text(p, 'paragraph', 6000)) };
  });
  if (value.en !== undefined) {
    const original = section => ({ heading: section.heading, paragraphs: [...section.paragraphs] });
    if (!Array.isArray(value.en) || value.en.length < 1 || value.en.length > 16) out.en = out.fr.map(original);
    else out.en = value.en.map((section, index) => {
      const source = out.fr[index] || out.fr[0];
      try { keys(section, ['heading', 'paragraphs'], 'section'); }
      catch (_) { return original(source); }
      let heading;
      try { heading = text(section.heading, 'heading', 180); }
      catch (_) { heading = source.heading; }
      if (!Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.length > 20)
        return { heading, paragraphs: [...source.paragraphs] };
      return { heading, paragraphs: section.paragraphs.map((paragraph, number) => {
        try { return text(paragraph, 'paragraph', 6000); }
        catch (_) { return source.paragraphs[number] || source.paragraphs[0]; }
      }) };
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
  } else if (leg || item.source === 'rdj_football_analysis' || item.source === 'rdj_multisport_analysis') {
    const publisherId = url.pathname.match(/-(\d+)\.html$/);
    if (!publisherId || publisherId[1] !== item.sourceId) throw failure('Identifiant de rencontre incoherent avec la fiche RDJ');
    if (item.source === 'rdj_multisport_analysis') {
      const dates = [...url.pathname.matchAll(/(\d{2})-(\d{2})-(\d{4})(?=\D|$)/g)];
      if (dates.some(date => `${date[3]}-${date[2]}-${date[1]}` !== editionDateFor(item.startsAtUtc))) throw failure('Date de fiche NBA/multisport incoherente avec son evenement');
    }
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
  keys(input, ['source', 'sourceId', 'sourceUrl', 'editionDate', 'kind', 'title', 'summary', 'startsAtUtc', 'sport', 'competition', 'teams', 'race', 'analysis', 'selection', 'legs', 'status', 'curation', 'editionConvention', 'scheduleProof'], 'item');
  if (input.source !== undefined && input.source !== source) throw failure('Source incoherente dans item');
  if (input.editionDate !== undefined && input.editionDate !== editionDate) throw failure('Date incoherente dans item');
  const info = sourceByKey(source);
  if (!info || !KINDS.includes(input.kind) || (leg ? input.kind !== 'match' : !info.kinds.includes(input.kind))) throw failure('Type de contenu incompatible avec la source');
  const normalized = {
    source, editionDate,
    sourceId: text(input.sourceId, 'sourceId', 220),
    sourceUrl: leg ? validatePublisherUrl(input.sourceUrl, 'rdj_football_analysis') : validatePublisherUrl(input.sourceUrl, source),
    kind: input.kind, title: i18n(input.title, 'title', 220), summary: i18n(input.summary, 'summary', 700, true),
    startsAtUtc: timestamp(input.startsAtUtc, editionDate, leg, input),
    analysis: analysis(input.analysis), selection: selection(input.selection),
    status: input.status || 'unknown',
  };
  if (!STATUSES.includes(normalized.status)) throw failure('Statut de rencontre inconnu');
  if (input.curation !== undefined) {
    keys(input.curation, ['kind', 'publisher', 'bookmaker', 'sourceUrl'], 'curation');
    if (input.curation.kind !== 'publisher_ticket' || input.curation.publisher !== 'RDJ' || input.kind !== 'combine' || leg) throw failure('Seul un ticket explicitement publie par RDJ est accepte');
    const url = validatePublisherUrl(input.curation.sourceUrl, source);
    if (url !== normalized.sourceUrl) throw failure('La provenance du ticket doit correspondre a son article');
    normalized.curation = { kind: 'publisher_ticket', publisher: 'RDJ', sourceUrl: url };
    if (input.curation.bookmaker !== undefined) normalized.curation.bookmaker = text(input.curation.bookmaker, 'curation.bookmaker', 100);
  }
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
    if (source === 'rdj_multisport_analysis' && !['basketball', 'volleyball'].includes(normalized.sport.key)) throw failure('Expert Multisports accepte uniquement le basket et le volley');
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
    if (source === 'rdj_football_duo' || source === 'rdj_football_goals') {
      const eventKeys = normalized.legs.map(item => [item.teams.home.name.trim().toLowerCase(), item.teams.away.name.trim().toLowerCase()].sort().join('|') + '|' + item.startsAtUtc);
      if (new Set(eventKeys).size !== eventKeys.length) throw failure('Un ticket doit porter sur des evenements distincts');
      if (!normalized.curation || normalized.selection.betType !== 'accumulator' || normalized.selection.totalOdds === null || normalized.selection.totalOdds <= 1) throw failure('Ticket RDJ, type accumulator et cote totale publiee requis');
      if (source === 'rdj_football_duo' && (normalized.legs.length !== 2 || normalized.selection.totalOdds < 2 || normalized.selection.totalOdds > 4)) throw failure('Le Duo du Jour requiert exactement deux rencontres et une cote totale de 2 a 4');
      if (source === 'rdj_football_goals' && (normalized.legs.length > 3 || normalized.legs.some(item => !['btts', 'over_under_goals', 'team_goals'].includes(item.selection.betType)))) throw failure('Combine Buts requiert deux ou trois rencontres sur des marches de buts explicites');
    }
    // A combined price is supplied by the publisher, never calculated here.
  }
  overnightProof(input, normalized);
  verifyIdentity(normalized, leg);
  return normalized;
}
function validateBatch(body, now = new Date()) {
  keys(body, ['source', 'editionDate', 'items', 'editorialCopy', 'couponTeaser'], 'batch');
  const source = sourceByKey(body.source);
  if (!source) throw failure('Source editoriale inconnue');
  const editionDate = dateOnly(body.editionDate);
  if (editionDate !== editionDateFor(now)) throw failure('Seule une edition du jour Europe/Paris peut etre importee');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw failure('Le lot doit contenir entre 1 et 50 contenus');
  if (source.key === 'rdj_football_duo' && body.items.length !== 1) throw failure('Un seul Duo du Jour est autorise par edition');
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
  const batch = { source: source.key, editionDate, items };
  if (Object.prototype.hasOwnProperty.call(body, 'editorialCopy')) {
    const { factsFromBatch, validateCopy, V2_VERSION } = require('./editorialCopy');
    try { batch.editorialCopy = validateCopy(factsFromBatch(batch), body.editorialCopy); }
    catch (error) {
      // A new cosmetic hook must never prevent a valid source batch from
      // publishing. Preserve the established v1 validation contract.
      if (body.editorialCopy?.version !== V2_VERSION || error.errorCode !== 'EDITORIAL_COPY_INVALID') throw error;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'couponTeaser')) {
    try {
      const { validateTeaser, teaserFactsFromBatch } = require('./couponTeaser');
      batch.couponTeaser = validateTeaser(teaserFactsFromBatch(batch), body.couponTeaser);
    } catch (_) { /* Optional card wording never blocks valid source content. */ }
  }
  return batch;
}

function hasCompleteEnglish(item) {
  // Publication requires usable text, not proof that a translator chose the
  // same wording or numeric representation. Quality diagnostics are advisory.
  const translated = value => value && typeof value.en === 'string' && value.en.trim();
  if (!translated(item.title) || (item.summary && item.summary.fr && !translated(item.summary)) || !translated(item.selection && item.selection.label)) return false;
  const en = item.analysis && item.analysis.en;
  if (!Array.isArray(en) || !en.length) return false;
  if (!en.every(section => {
    return section && typeof section.heading === 'string' && section.heading.trim() &&
      Array.isArray(section.paragraphs) && section.paragraphs.length &&
      section.paragraphs.every(p => typeof p === 'string' && p.trim());
  })) return false;
  return !item.legs || item.legs.every(hasCompleteEnglish);
}
function completeEnglishWithFallback(items) {
  // Operate only on schema-normalized content. Preserve every supplied English
  // string; when a translation is unavailable the original is preferable to a
  // missing edition. Structured source facts (odds, clocks, teams) stay intact.
  for (const item of items) {
    for (const value of [item.title, item.summary, item.selection.label]) {
      if (value && value.fr && !(typeof value.en === 'string' && value.en.trim())) value.en = value.fr;
    }
    const analysis = item.analysis;
    if (!Array.isArray(analysis.en)) analysis.en = [];
    analysis.fr.forEach((section, index) => {
      if (!analysis.en[index]) analysis.en[index] = { heading: section.heading, paragraphs: [...section.paragraphs] };
      else {
        const other = analysis.en[index];
        if (!(typeof other.heading === 'string' && other.heading.trim())) other.heading = section.heading;
        if (!Array.isArray(other.paragraphs)) other.paragraphs = [];
        section.paragraphs.forEach((paragraph, number) => {
          if (!(typeof other.paragraphs[number] === 'string' && other.paragraphs[number].trim())) other.paragraphs[number] = paragraph;
        });
      }
    });
    if (item.legs) completeEnglishWithFallback(item.legs);
  }
  return items;
}
function requireCompleteEnglish(items) {
  if (!items.every(hasCompleteEnglish)) throw failure('Texte anglais ou original de remplacement requis');
}

module.exports = { validateBatch, normalizeItem, dateOnly, hasCompleteEnglish, requireCompleteEnglish, completeEnglishWithFallback };
