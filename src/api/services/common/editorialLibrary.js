const { SOURCES, sourceByKey, failure, readableSources, categoryAcceptsSource } = require('./editorialSources');
const { dateOnly } = require('./editorialValidation');
const { editionDateFor } = require('./editorialCalendar');
const { editorialAccess, requireEditorialAccess } = require('./editorialAccess');
const { editorialDescriptionFields } = require('./editorialDescriptions');

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
function openingInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, 'openingId') || typeof body.openingId !== 'string' || body.openingId.length !== 36 ||
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(body.openingId)) {
    throw failure('Identifiant d ouverture invalide');
  }
  return body.openingId.toLowerCase();
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

function withSelectionPreview(preview, payload, lang) {
  const value = payload?.selection?.label;
  const candidates = typeof value === 'string' ? [value] : [value?.[lang], value?.fr, value?.en];
  const label = candidates.find(text => typeof text === 'string' && text.trim());
  const result = { ...preview };
  if (label !== undefined) result.selectionPreview = { label: label.trim() };
  if (Array.isArray(preview.legs) && Array.isArray(payload?.legs)) {
    // Keep every leg bound to its own sourced pick, never the accumulator label.
    result.legs = preview.legs.map((leg, index) => withSelectionPreview(leg, payload.legs[index], lang));
  }
  return result;
}

// Storefront facts only: a published price can promote VIP without exposing
// its pick or granting access. Never reconstruct accumulator odds from legs.
function vipHeadline(category, items, date, requestDate, instant) {
  const empty = { headlineOdds: null, headlineOddsExpiresAtUtc: null };
  if (category.isVip !== true || date !== requestDate) return empty;
  const now = instant.getTime();
  const futureStart = item => {
    const value = item?.startsAtUtc;
    if (item?.status !== 'upcoming' || item.editionDate !== date || typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return null;
    try { dateOnly(value.slice(0, 10)); } catch (_) { return null; }
    const start = Date.parse(value);
    return Number.isFinite(start) && start > now ? start : null;
  };
  let best = null;
  for (const row of items) {
    if (row.isPublished !== true) continue;
    const payload = row.payload;
    if (!payload || payload.status !== 'upcoming') continue;
    let deadline;
    if (payload.kind === 'combine') {
      if (!Array.isArray(payload.legs) || payload.legs.length < 2 || payload.legs.length > 12) continue;
      const starts = Array.from(payload.legs, leg => leg?.kind === 'match' ? futureStart(leg) : null);
      if (starts.some(value => value === null)) continue;
      deadline = Math.min(...starts);
      if (payload.startsAtUtc !== null && payload.startsAtUtc !== undefined && futureStart(payload) !== deadline) continue;
    } else {
      if (!['match', 'horse_racing'].includes(payload.kind)) continue;
      deadline = futureStart(payload);
      if (deadline === null) continue;
    }
    const odds = payload.kind === 'combine' ? payload.selection?.totalOdds :
      payload.selection?.totalOdds ?? payload.selection?.odds;
    if (typeof odds !== 'number' || !Number.isFinite(odds) || odds <= 1 || odds > 100000) continue;
    if (!best || odds > best.odds || odds === best.odds && deadline < best.deadline) best = { odds, deadline };
  }
  // This is the promotion's validity deadline, not necessarily the event's
  // kickoff. Overnight fixtures must stop advertising yesterday's edition at
  // the next publisher midnight; use its timezone database across DST changes.
  if (!best) return empty;
  // Locate the exact calendar boundary with the shared Intl publisher calendar
  // rather than assuming a fixed UTC offset or a twenty-four-hour Paris day.
  let beforeMidnight = now, publisherMidnight = now + 48 * 60 * 60 * 1000;
  while (publisherMidnight - beforeMidnight > 1) {
    const probe = Math.floor((beforeMidnight + publisherMidnight) / 2);
    if (editionDateFor(probe) === requestDate) beforeMidnight = probe;
    else publisherMidnight = probe;
  }
  return { headlineOdds: best.odds,
    headlineOddsExpiresAtUtc: new Date(Math.min(best.deadline, publisherMidnight)).toISOString() };
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
      categories.flatMap(category => readableSources(category).map(source => ({ categoryId: category._id, source }))));
    return [...new Set(values.filter(value => { try { return dateOnly(value) <= requestDate; } catch (_) { return false; } }))].sort().reverse().slice(0, 10);
  }
  function rowsFor(category, rows, date) {
    const selected = rows.filter(row => id(row.categoryId) === id(category) && categoryAcceptsSource(category, row.source) &&
      row.editionDate === date && row.isPublished !== false && row.payload?.source === row.source && row.payload?.editionDate === date);
    if (selected.length > 100) throw failure('Edition trop volumineuse', 503);
    return selected;
  }
  function dailyDescription(category, items, copies, lang) {
    const { boundCopy } = require('./editorialCopy');
    const record = copies.find(record => record.source === (items[0]?.source || category.editorialSource));
    const copy = boundCopy(record, items);
    // Read-time presentation only: one short hook, regardless of match count.
    // Existing source content and immutable notification snapshots stay intact.
    const teaser = require('./couponTeaser').boundTeaser(record, items);
    return editorialDescriptionFields(items, lang, copy, teaser);
  }
  async function card(category, items, date, copies, stats, lang, user, requestDate, openings, instant) {
    const state = await editorialAccess(repository, category, user);
    const source = sourceByKey(category.editorialSource);
    return { id: id(category), categoryId: id(category), name: pick(category.name, lang),
      ...dailyDescription(category, items, copies, lang), icon: category.icon || '',
      isVip: category.isVip === true, editorialSource: category.editorialSource,
      source: { key: source.key, label: source.label, kinds: [...source.kinds] },
      locked: state.locked, requiresAuth: state.requiresAuth, gate: state.gate,
      itemCount: items.length, available: items.length > 0, editionDate: date, currentDate: requestDate,
      ...vipHeadline(category, items, date, requestDate, instant),
      openingCount: openings.find(row => id(row.categoryId) === id(category))?.openingCount || 0,
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
      const instant = new Date(clock()), requestDate = editionDateFor(instant);
      const editionDate = checkedDate(date === undefined ? requestDate : date, requestDate);
      const categories = (await repository.categories()).filter(category => eligible(category) && category.isVip === isVip)
        .sort((a, b) => SOURCES.findIndex(source => source.key === a.editorialSource) - SOURCES.findIndex(source => source.key === b.editorialSource) || id(a).localeCompare(id(b)));
      // The default is today's edition. A missing publisher issue must never be
      // silently relabelled as today's content; ten real dates remain selectable.
      const [availableDates, rows, copies, stats, openings] = await Promise.all([
        dates(categories, requestDate), repository.items(categories.map(category => category._id), editionDate),
        repository.copies ? repository.copies([...new Set(categories.flatMap(readableSources))], editionDate) : [],
        repository.reviewSummaries(categories.map(category => category._id), editionDate),
        repository.openingCounts ? repository.openingCounts(categories.map(category => category._id), editionDate) : [],
      ]);
      return { date: editionDate, currentDate: requestDate, availableDates, categories: await Promise.all(categories.map(category =>
        card(category, rowsFor(category, rows, editionDate), editionDate, copies, stats, language, user, requestDate, openings, instant))) };
    },
    async edition(categoryId, date, { lang = 'fr', user = null } = {}) {
      const instant = new Date(clock()), requestDate = editionDateFor(instant);
      const { category, editionDate, items } = await loadEdition(categoryId, date, requestDate);
      const [copies, stats, openings] = await Promise.all([
        repository.copies ? repository.copies(readableSources(category), editionDate) : [],
        repository.reviewSummaries([category._id], editionDate),
        repository.openingCounts ? repository.openingCounts([category._id], editionDate) : [],
      ]);
      const language = languageOf(lang);
      const result = await card(category, items, editionDate, copies, stats, language, user, requestDate, openings, instant);
      result.selectionPreviewsAvailable = result.locked === false && items.length > 0;
      if (result.selectionPreviewsAvailable) {
        // This access-checked detail adds labels only. The public library and
        // locked previews keep their existing allowlist; analysis stays in content.
        result.previewItems = result.previewItems.map((preview, index) =>
          withSelectionPreview(preview, items[index].payload, language));
      }
      return result;
    },
    async open(categoryId, date, body, { user = null } = {}) {
      const openingId = openingInput(body);
      const instant = clock(), requestDate = editionDateFor(instant);
      const { category, editionDate } = await loadEdition(categoryId, date, requestDate);
      requireEditorialAccess(await editorialAccess(repository, category, user), category, user);
      if (!repository.recordOpening) throw failure('Compteur des ouvertures indisponible', 503);
      const result = await repository.recordOpening(category._id, editionDate, openingId, instant);
      return { categoryId: id(category), editionDate, openingCount: result.openingCount, counted: result.counted };
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

module.exports = { createEditorialLibrary, pagination, reviewInput, reviewView, openingInput };
