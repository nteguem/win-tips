// Fixed publisher catalogue; category selection stays under back-office control.
const SOURCES = Object.freeze([
  { key: 'rdj_petit_journal', label: 'Le Petit Journal', description: 'Les matchs et analyses du jour', access: 'free', selectable: true, url: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html', kinds: ['match'] },
  { key: 'rdj_turf_quinte', label: 'Le Quinté du Jour', description: 'Les courses, analyses et sélections du Quinté+', access: 'free', selectable: true, url: 'https://www.ruedesjoueurs.com/turf/pronostic-turf.html', kinds: ['horse_racing'] },
  { key: 'rdj_football_analysis', label: 'Sélection Expert', description: 'Des paris simples et leur analyse football', access: 'vip', selectable: true, url: 'https://www.ruedesjoueurs.com/pronostics/foot.html', kinds: ['match'] },
  { key: 'rdj_football_duo', label: 'Le Duo du Jour', description: 'Deux rencontres, une cote totale de 2 à 4', access: 'vip', selectable: true, url: 'https://www.ruedesjoueurs.com/actualites/paris-sportifs.html', kinds: ['combine'], constraints: { minEvents: 2, maxEvents: 2, minTotalOdds: 2, maxTotalOdds: 4 } },
  { key: 'rdj_football_goals', label: 'Combiné Buts', description: 'Deux ou trois rencontres sur les marchés de buts', access: 'vip', selectable: true, url: 'https://www.ruedesjoueurs.com/actualites/paris-sportifs.html', kinds: ['combine'], constraints: { minEvents: 2, maxEvents: 3, markets: ['btts', 'over_under_goals', 'team_goals'] } },
  { key: 'rdj_multisport_analysis', label: 'Expert Multisports', description: 'Des paris simples analysés en basket et volley', access: 'vip', selectable: true, url: 'https://www.ruedesjoueurs.com/pronostics.html', kinds: ['match'], constraints: { sports: ['basketball', 'volleyball'] } },
  // Existing category mappings and past imports remain readable. This source
  // cannot be newly assigned through the back-office or the catalogue seed.
  { key: 'rdj_football_combine', label: 'Combinés RDJ (ancien)', access: 'vip', selectable: false, legacy: true, url: 'https://www.ruedesjoueurs.com/actualites/paris-sportifs.html', kinds: ['combine'] },
].map(s => Object.freeze({ ...s, kinds: Object.freeze(s.kinds),
  ...(s.constraints ? { constraints: Object.freeze(Object.fromEntries(Object.entries(s.constraints).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze(value) : value]))) } : {}),
})));

function failure(message, statusCode = 400, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function sourceByKey(key) { return SOURCES.find(s => s.key === key) || null; }

function validateCategorySource(value, isVip) {
  if (value === null || value === undefined || value === '') return null;
  if (isVip !== undefined && typeof isVip !== 'boolean') throw failure('isVip doit etre un booleen');
  if (typeof value !== 'string' || !sourceByKey(value)) throw failure('Source editoriale inconnue');
  if (sourceByKey(value).access !== (isVip === true ? 'vip' : 'free')) {
    throw failure('La source doit correspondre au niveau gratuit ou VIP de la categorie');
  }
  return value;
}

function validateCategoryAssignment(value, isVip, previousSource = null) {
  const selected = validateCategorySource(value, isVip);
  if (selected && sourceByKey(selected).selectable === false && selected !== previousSource) {
    throw failure('Cette ancienne source ne peut plus etre affectee a une categorie');
  }
  return selected;
}

function containsEditorialField(value) {
  const protectedField = key => ['editorialSource', 'catalogueArchived', 'catalogueKey'].some(field => key === field || key.startsWith(field + '.'));
  if (typeof value === 'string') return protectedField(value);
  return !!(value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    protectedField(key) || containsEditorialField(child)));
}

function validatePublisherUrl(value, source) {
  let url;
  try { url = new URL(value); } catch (_) { throw failure('URL RDJ invalide'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.ruedesjoueurs.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw failure('Une URL canonique HTTPS RueDesJoueurs est requise');
  }
  const patterns = {
    rdj_petit_journal: /^\/paris-sportifs\/le-petit-journal(?:\/[\w-]+)?\.html$/,
    rdj_turf_quinte: /^\/turf\/pronostic-turf(?:\/course\/\d{2}-\d{2}-\d{4}\/R\d+\/C\d+\/[\w-]+|\/pronostics-quinte\/[\w-]+)?\.html$/,
    rdj_football_analysis: /^\/pronostic\/[\w-]+-\d+\.html$/,
    rdj_multisport_analysis: /^\/pronostic\/[\w-]+-\d+\.html$/,
    rdj_football_duo: /^\/(?:actualites\/paris-sportifs|paris-sportifs\/sport-news\/news-(?:betclic|pmu-sport|unibet|winamax-paris-sportifs))\/[\w-]+\.html$/,
    rdj_football_goals: /^\/(?:actualites\/paris-sportifs|paris-sportifs\/sport-news\/news-(?:betclic|pmu-sport|unibet|winamax-paris-sportifs))\/[\w-]+\.html$/,
    rdj_football_combine: /^\/(?:actualites\/paris-sportifs|paris-sportifs\/sport-news\/news-(?:betclic|pmu-sport|unibet|winamax-paris-sportifs))\/[\w-]+\.html$/,
  };
  if (!patterns[source] || !patterns[source].test(url.pathname)) throw failure('URL hors de la source editoriale selectionnee');
  return url.href;
}

module.exports = { SOURCES, sourceByKey, validateCategorySource, validateCategoryAssignment, validatePublisherUrl, containsEditorialField, failure };
