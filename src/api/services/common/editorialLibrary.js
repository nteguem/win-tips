const { SOURCES, sourceByKey, failure } = require('./editorialSources');
const { dateOnly } = require('./editorialValidation');
const { editionDateFor } = require('./editorialCalendar');
const { editorialAccess, requireEditorialAccess } = require('./editorialAccess');
const { contextualDescription } = require('./editorialTeaser');

const id = value => String(value && value._id || value);
const languageOf = lang => lang === 'en' ? 'en' : 'fr';
const pick = (value, lang) => typeof value === 'string' ? value : value?.[lang] || value?.fr || value?.en || '';
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const cleanText = value => typeof value === 'string' && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);

function pagination(page = '1', limit = '10') {
  const integer = (value, max) => (typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^[1-9]\d{0,4}$/.test(value)) && Number(value) >= 1 && Number(value) <= max;
  if (!integer(page, 1000) || !integer(limit, 20)) throw failure('Pagination invalide');
  return { page: Number(page), limit: Number(limit) };
}
function reviewInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['rating', 'comment'].includes(key)) ||
      !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5 ||
      body.comment !== undefined && (!cleanText(body.comment) || body.comment.length > 1500)) throw failure('Avis invalide');
  return { rating: body.rating, comment: (body.comment || '').trim() };
}
function authorName(user, lang) {
  // Neither email nor phone is used as the public review identity.
  const candidate = user.pseudo || user.firstName;
  return cleanText(candidate) && candidate.trim() ? candidate.trim().slice(0, 40).replace(/[\ud800-\udbff]$/u, '') : (lang === 'en' ? 'Reader' : 'Lecteur');
}
function reviewView(row, user) {
  return { id: id(row), authorName: row.authorName, rating: row.rating, comment: row.comment || '',
    createdAt: row.createdAt, updatedAt: row.updatedAt, isMine: !!user && id(row.userId) === id(user) };
}
const emptySummary = () => ({ count: 0, averageRating: null });
function safeSummary(value) {
  if (!value || !Number.isSafeInteger(value.count) || value.count <= 0 || !Number.isFinite(value.averageRating) ||
      value.averageRating < 1 || value.averageRating > 5) return emptySummary();
  return { count: value.count, averageRating: Math.round(value.averageRating * 10) / 10 };
}

function createEditorialLibrary({ repository, clock, sourceMatchesCategory, summary, metadata }) {
  const eligible = category => sourceMatchesCategory(category) && category.catalogueArchived !== true;
  const currentDate = () => editionDateFor(clock());
  function checkedDate(date, requestDate) {
    const value = dateOnly(date);
    if (value > requestDate) throw failure('Edition future indisponible', 404);
    return value;
  }
  async function dates(categories, requestDate) {
    const values = await repository.availableDates(categories.map(category => category._id), requestDate, 10,
      categories.map(category => ({ categoryId: category._id, source: category.editorialSource })));
    return [...new Set(values.filter(value => { try { return dateOnly(value) <= requestDate; } catch (_) { return false; } }))].sort().reverse().slice(0, 10);
  }
  function rowsFor(category, rows, date) {
    const selected = rows.filter(row => id(row.categoryId) === id(category) && row.source === category.editorialSource &&
      row.editionDate === date && row.isPublished !== false && row.payload?.source === row.source && row.payload?.editionDate === date);
    if (selected.length > 100) throw failure('Edition trop volumineuse', 503);
    return selected;
  }
  function dailyDescription(category, items, copies, lang) {
    const contextual = contextualDescription(items, lang);
    if (contextual) return { description: contextual, editorialDescription: contextual };
    const copy = require('./editorialCopy').boundCopy(copies.find(record => record.source === category.editorialSource), items);
    if (copy) return { description: copy.body[lang], editorialDescription: copy.body[lang] };
    if (!items.length) return { description: lang === 'en' ? 'This edition is not available yet.' : 'Cette edition n\u2019est pas encore disponible.' };
    // No request-time AI and no unverified streaks. The factual fallback only
    // uses today's public team/race labels, never picks or analysis paragraphs.
    const labels = items.map(row => row.payload.race ? `${row.payload.race.name} \u00b7 ${row.payload.race.racecourse || ''}`.trim() :
      (row.payload.legs || [row.payload]).map(item => item.teams ? `${item.teams.home.name} \u2014 ${item.teams.away.name}` : pick(item.title, lang)).join(' / '));
    const unique = [...new Set(labels)];
    return { description: unique.slice(0, 3).join(' \u2022 ') + (unique.length > 3 ? ` +${unique.length - 3}` : '') };
  }
  async function card(category, items, date, copies, stats, lang, user, requestDate) {
    const state = await editorialAccess(repository, category, user);
    const source = sourceByKey(category.editorialSource);
    return { id: id(category), categoryId: id(category), name: pick(category.name, lang),
      ...dailyDescription(category, items, copies, lang), icon: category.icon || '',
      isVip: category.isVip === true, editorialSource: category.editorialSource,
      source: { key: source.key, label: source.label, kinds: [...source.kinds] },
      locked: state.locked, requiresAuth: state.requiresAuth, gate: state.gate,
      itemCount: items.length, available: items.length > 0, editionDate: date, currentDate: requestDate,
      coverKey: category.editorialSource, reviewSummary: safeSummary(stats.find(row => id(row.categoryId) === id(category))),
      // Force the allowlisted preview even for subscribers. Raw summaries can
      // contain a selection; only the separately screened teaser is public.
      // Full structured content belongs inside the protected native reader.
      previewItems: items.map(row => summary(row, true, lang)) };
  }
  async function loadEdition(categoryId, date, requestDate) {
    if (!validId(categoryId)) throw failure('Coupon introuvable', 404);
    const editionDate = checkedDate(date, requestDate);
    const category = await repository.category(categoryId);
    if (!category || !eligible(category)) throw failure('Coupon introuvable', 404);
    const items = rowsFor(category, await repository.items([category._id], editionDate), editionDate);
    if (!items.length) throw failure('Edition introuvable', 404);
    return { category, editionDate, items };
  }
  return {
    async library({ isVip = false, date, lang = 'fr', user = null } = {}) {
      if (isVip !== true && isVip !== false) throw failure('isVip doit etre true ou false');
      const language = languageOf(lang);
      // Freeze the publisher day before the first asynchronous read. A request
      // crossing Paris midnight must have one date in guards, dates and cards.
      const requestDate = currentDate();
      const editionDate = checkedDate(date === undefined ? requestDate : date, requestDate);
      const categories = (await repository.categories()).filter(category => eligible(category) && category.isVip === isVip)
        .sort((a, b) => SOURCES.findIndex(source => source.key === a.editorialSource) - SOURCES.findIndex(source => source.key === b.editorialSource) || id(a).localeCompare(id(b)));
      // The default is today's edition. A missing publisher issue must never be
      // silently relabelled as today's content; ten real dates remain selectable.
      const [availableDates, rows, copies, stats] = await Promise.all([
        dates(categories, requestDate), repository.items(categories.map(category => category._id), editionDate),
        repository.copies ? repository.copies([...new Set(categories.map(category => category.editorialSource))], editionDate) : [],
        repository.reviewSummaries(categories.map(category => category._id), editionDate),
      ]);
      return { date: editionDate, currentDate: requestDate, availableDates, categories: await Promise.all(categories.map(category =>
        card(category, rowsFor(category, rows, editionDate), editionDate, copies, stats, language, user, requestDate))) };
    },
    async edition(categoryId, date, { lang = 'fr', user = null } = {}) {
      const requestDate = currentDate();
      const { category, editionDate, items } = await loadEdition(categoryId, date, requestDate);
      const [copies, stats] = await Promise.all([
        repository.copies ? repository.copies([category.editorialSource], editionDate) : [],
        repository.reviewSummaries([category._id], editionDate),
      ]);
      return card(category, items, editionDate, copies, stats, languageOf(lang), user, requestDate);
    },
    async content(categoryId, date, { lang = 'fr', user = null } = {}) {
      const requestDate = currentDate();
      const { category, editionDate, items } = await loadEdition(categoryId, date, requestDate);
      requireEditorialAccess(await editorialAccess(repository, category, user), category, user);
      const language = languageOf(lang);
      return { categoryId: id(category), editionDate, locked: false, requestedLanguage: language,
        items: items.map(row => ({ ...row.payload, id: id(row), categoryId: id(category), locked: false, ...metadata(row.payload, language) })) };
    },
    async reviews(categoryId, date, { page, limit, user = null } = {}) {
      const window = pagination(page, limit);
      const requestDate = currentDate();
      const { category, editionDate } = await loadEdition(categoryId, date, requestDate);
      const [result, own] = await Promise.all([
        repository.reviews(category._id, editionDate, window),
        user ? repository.userReview(category._id, editionDate, user._id) : null,
      ]);
      return { ...window, total: result.total, hasNext: window.page * window.limit < result.total,
        items: result.rows.map(row => reviewView(row, user)), myReview: own ? reviewView(own, user) : null };
    },
    async putReview(categoryId, date, body, { lang = 'fr', user = null } = {}) {
      if (!user) throw failure('Authentification requise', 401, 'AUTH_TOKEN_MISSING');
      const input = reviewInput(body);
      const requestDate = currentDate();
      const { category, editionDate } = await loadEdition(categoryId, date, requestDate);
      requireEditorialAccess(await editorialAccess(repository, category, user), category, user);
      const row = await repository.upsertReview(category._id, editionDate, user._id,
        { ...input, authorName: authorName(user, languageOf(lang)) });
      return { review: reviewView(row, user) };
    },
  };
}

module.exports = { createEditorialLibrary, pagination, reviewInput, reviewView };
