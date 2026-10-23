// Fixed publisher catalogue; category selection stays under back-office control.
const SOURCES = Object.freeze([
  { key: 'rdj_petit_journal', label: 'Petit Journal du parieur', access: 'free', url: 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html', kinds: ['match'] },
  { key: 'rdj_turf_quinte', label: 'Quinte RDJ', access: 'free', url: 'https://www.ruedesjoueurs.com/turf/pronostic-turf.html', kinds: ['horse_racing'] },
  { key: 'rdj_football_analysis', label: 'Analyses football RDJ', access: 'vip', url: 'https://www.ruedesjoueurs.com/pronostics/foot.html', kinds: ['match'] },
  { key: 'rdj_football_combine', label: 'Combines editoriaux RDJ', access: 'vip', url: 'https://www.ruedesjoueurs.com/actualites/paris-sportifs.html', kinds: ['combine'] },
].map(s => Object.freeze({ ...s, kinds: Object.freeze(s.kinds) })));

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

function containsEditorialField(value) {
  if (typeof value === 'string') return value === 'editorialSource' || value.startsWith('editorialSource.');
  return !!(value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    key === 'editorialSource' || key.startsWith('editorialSource.') || containsEditorialField(child)));
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
    rdj_football_combine: /^\/(?:actualites\/paris-sportifs|paris-sportifs\/sport-news\/news-(?:betclic|pmu-sport|unibet|winamax-paris-sportifs))\/[\w-]+\.html$/,
  };
  if (!patterns[source] || !patterns[source].test(url.pathname)) throw failure('URL hors de la source editoriale selectionnee');
  return url.href;
}

module.exports = { SOURCES, sourceByKey, validateCategorySource, validatePublisherUrl, containsEditorialField, failure };
