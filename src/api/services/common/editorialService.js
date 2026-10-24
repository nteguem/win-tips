const crypto = require('crypto');
const { SOURCES, sourceByKey, validateCategorySource, failure } = require('./editorialSources');
const { validateBatch, normalizeItem, dateOnly, hasCompleteEnglish, requireCompleteEnglish } = require('./editorialValidation');
const { editionDateFor } = require('./editorialCalendar');

const pickLang = (value, lang) => typeof value === 'string' ? value : (value && (value[lang] || value.fr || value.en)) || '';
const id = value => String(value && value._id || value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const WINDOW_SOURCES = ['rdj_petit_journal', 'rdj_turf_quinte'];
const storedEnglishStructure = item => {
  const translated = value => typeof value?.en === 'string' && !!value.en.trim();
  return translated(item.title) && (!item.summary?.fr || translated(item.summary)) && translated(item.selection?.label) &&
    Array.isArray(item.analysis?.en) && item.analysis.en.length === item.analysis.fr.length &&
    item.analysis.fr.every((section, index) => typeof item.analysis.en[index].heading === 'string' &&
      !!item.analysis.en[index].heading.trim() && Array.isArray(item.analysis.en[index].paragraphs) &&
      item.analysis.en[index].paragraphs.length === section.paragraphs.length &&
      item.analysis.en[index].paragraphs.every(p => typeof p === 'string' && !!p.trim()));
};

// An inventory of published identities, not a declaration that a publisher's
// whole edition is complete. The worker must still match the current inventory.
async function publishedSourceWindows(repository, categories, editionDate, instant) {
  const result = { version: 'published-source-windows-v1', editionDate, checkedAtUtc: instant.toISOString(), sources: [] };
  const unknown = (source, reason) => ({ source, ready: false, reason });
  let rows;
  try {
    const ids = categories.filter(c => WINDOW_SOURCES.includes(c.editorialSource)).map(c => c._id);
    rows = ids.length ? await repository.sourceWindowItems(ids, editionDate) : [];
    if (!Array.isArray(rows) || rows.length > 50) throw new Error('invalid_inventory');
  } catch (_) {
    result.sources = WINDOW_SOURCES.map(source => unknown(source, 'published_inventory_unavailable'));
    return result;
  }
  for (const source of WINDOW_SOURCES) {
    try {
      const mappings = categories.filter(c => c.editorialSource === source);
      if (mappings.length !== 1 || !sourceMatchesCategory(mappings[0]) || mappings[0].isVip !== false ||
          mappings[0].catalogueArchived === true || !/^[a-f\d]{24}$/i.test(id(mappings[0]))) throw new Error('mapping');
      const categoryId = id(mappings[0]);
      const selected = rows.filter(row => id(row.categoryId) === categoryId);
      if (!selected.length || selected.length > (source === 'rdj_petit_journal' ? 8 : 1)) throw new Error('count');
      const items = selected.map(row => {
        if (row.isPublished !== true || row.source !== source || row.editionDate !== editionDate ||
            row.payload?.source !== source || row.payload?.editionDate !== editionDate ||
            row.payload?.sourceId !== row.sourceId || row.payload?.kind !== row.kind ||
            !/^[a-f\d]{64}$/.test(row.contentHash || '') ||
            crypto.createHash('sha256').update(JSON.stringify(row.payload)).digest('hex') !== row.contentHash) throw new Error('row');
        const item = normalizeItem(row.payload, source, editionDate);
        // This read-only identity proof does not re-publish/re-qualify historic
        // wording under today's numeric-equivalence rules. Import stays strict.
        if (!storedEnglishStructure(item)) throw new Error('english_structure');
        if (!item.startsAtUtc || new Date(row.startsAtUtc).toISOString() !== item.startsAtUtc || item.status !== 'upcoming') throw new Error('clock');
        return { sourceId: item.sourceId, sourceUrl: item.sourceUrl, kind: item.kind, startsAtUtc: item.startsAtUtc,
          sport: { key: item.sport.key },
          ...(item.teams ? { teams: item.teams, competition: { name: item.competition.name } } : {}),
          ...(item.race ? { race: { meetingNumber: item.race.meetingNumber, raceNumber: item.race.raceNumber } } : {}) };
      });
      if (new Set(items.map(item => item.sourceId)).size !== items.length) throw new Error('duplicate');
      result.sources.push({ source, ready: true, categoryId, count: items.length,
        latestStartsAtUtc: new Date(Math.max(...items.map(item => Date.parse(item.startsAtUtc)))).toISOString(), items });
    } catch (_) { result.sources.push(unknown(source, 'published_inventory_not_proven')); }
  }
  return result;
}

function metadata(payload, lang) {
  const translated = !!hasCompleteEnglish(payload);
  return { contentLanguage: lang === 'en' && translated ? 'en' : 'fr', requestedLanguage: lang, originalLanguage: 'fr', translationAvailable: translated };
}

function summary(row, locked, lang) {
  const p = row.payload;
  // Explicit allowlist: never serialize payload/analysis/selection/sourceUrl/hash.
  const out = { id: id(row), source: row.source, sourceId: row.sourceId, editionDate: row.editionDate, kind: p.kind,
    title: p.title, startsAtUtc: p.startsAtUtc, sport: p.sport, status: p.status, locked,
    ...metadata(p, lang) };
  if (!locked) out.summary = p.summary;
  for (const key of ['competition', 'teams']) if (own(p, key)) out[key] = p[key];
  if (p.race) {
    const { runners, ...race } = p.race;
    out.race = race; // Race card metadata is public; tips/runners odds stay in detail.
  }
  if (p.legs) out.legs = p.legs.map(leg => ({ kind: leg.kind, title: leg.title, teams: leg.teams,
    competition: leg.competition, startsAtUtc: leg.startsAtUtc, sport: leg.sport, status: leg.status }));
  return out;
}

function createEditorialService({ repository, clock = () => new Date(), importEnabled = () => false, requireEnglish = () => true, notifications = null }) {
  if (!repository) throw new TypeError('Editorial repository required');

  async function access(category, user) {
    if (category.isVip === true) {
      const allowed = !!(user && await repository.hasCategoryAccess(user._id, category._id));
      return { locked: !allowed, gate: null, requiresAuth: !user };
    }
    const subscriber = !!(user && await repository.hasAnySubscription(user._id));
    const gate = await repository.gate(user && user._id, category, subscriber);
    return { locked: !!gate.locked, requiresAuth: !user && !!gate.locked,
      gate: gate.gated ? { type: 'ad_reward', offers: gate.offers, state: gate.state, unlockCount: gate.unlockCount, requiresAuth: !user } : null };
  }

  return {
    catalog: () => SOURCES.map(s => ({ ...s, kinds: [...s.kinds] })),

    async workerConfig() {
      const categories = await repository.categories();
      const instant = clock(), editionDate = editionDateFor(instant);
      const ticketState = repository.ticketState ? await repository.ticketState(editionDate) : undefined;
      return { date: editionDate, importEnabled: !!importEnabled(), notificationsEnabled: !!(notifications && notifications.enabled()), requireEnglish: !!requireEnglish(),
        ...(ticketState ? { ticketState } : {}),
        publishedSourceWindows: await publishedSourceWindows(repository, categories, editionDate, instant),
        sources: SOURCES.map(s => ({ ...s, categoryIds: categories.filter(c => c.editorialSource === s.key && sourceMatchesCategory(c)).map(c => id(c)) })).filter(s => s.categoryIds.length) };
    },

    async importBatch(body) {
      if (!importEnabled()) throw failure('Import editorial non active', 403);
      const batch = validateBatch(body, clock());
      if (requireEnglish()) requireCompleteEnglish(batch.items);
      const categories = (await repository.categories()).filter(c => c.editorialSource === batch.source && sourceMatchesCategory(c));
      if (!categories.length) return { source: batch.source, date: batch.editionDate, ignored: true, reason: 'no_active_category_mapping', imported: 0, notificationsSent: 0 };
      // Every item and every target is validated before the first DAL write.
      const operations = [];
      for (const category of categories) {
        for (const item of batch.items) {
          const contentHash = crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
          operations.push({ updateOne: {
            filter: { categoryId: category._id, source: batch.source, editionDate: batch.editionDate, sourceId: item.sourceId },
            update: { $set: { kind: item.kind, startsAtUtc: item.startsAtUtc ? new Date(item.startsAtUtc) : null, payload: item, contentHash, isPublished: true },
              $setOnInsert: { notificationState: 'not_requested', notificationSentAt: null } },
            upsert: true,
          } });
        }
      }
      const result = await repository.upsertBatch(operations);
      let notificationResult = { disabled: true, sent: 0 };
      if (notifications && notifications.enabled()) {
        try { notificationResult = await notifications.drain({ source: batch.source, editionDate: batch.editionDate, dryRun: false }); }
        catch (_) { notificationResult = { pending: true, sent: 0, reason: 'notification_drain_unavailable' }; }
      }
      return { source: batch.source, date: batch.editionDate, categories: categories.map(c => id(c)), imported: batch.items.length,
        inserted: result.upsertedCount || 0, matched: result.matchedCount || 0, notificationsSent: notificationResult.sent || 0, notifications: notificationResult };
    },

    async drainNotifications(body = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['source', 'dryRun'].includes(key))) throw failure('Parametres de reprise invalides');
      if (!notifications) return { disabled: true, sent: 0 };
      return notifications.drain({ source: body.source, dryRun: body.dryRun !== undefined ? body.dryRun : true });
    },

    async feed({ isVip = false, date, lang = 'fr', user = null } = {}) {
      if (isVip !== false && isVip !== true) throw failure('isVip doit etre true ou false');
      if (isVip && !user) throw failure('Authentification requise', 401);
      const editionDate = dateOnly(date || editionDateFor(clock()));
      if (editionDate > editionDateFor(clock())) throw failure('Edition future indisponible', 404);
      const language = lang === 'en' ? 'en' : 'fr';
      const categories = (await repository.categories()).filter(c => c.isVip === isVip && sourceMatchesCategory(c));
      const rows = await repository.items(categories.map(c => c._id), editionDate);
      const output = [];
      for (const category of categories) {
        const state = await access(category, user);
        const items = rows.filter(row => id(row.categoryId) === id(category) && row.source === category.editorialSource);
        output.push({ id: id(category), name: pickLang(category.name, language), description: pickLang(category.description, language),
          icon: category.icon || '', isVip: category.isVip, editorialSource: category.editorialSource, source: { ...sourceByKey(category.editorialSource) },
          locked: state.locked, requiresAuth: state.requiresAuth, gate: state.gate,
          items: items.map(row => summary(row, state.locked, language)) });
      }
      return { date: editionDate, categories: output };
    },

    async analysis(itemId, { user = null, lang = 'fr' } = {}) {
      if (typeof itemId !== 'string' || !/^[a-f\d]{24}$/i.test(itemId)) throw failure('Contenu introuvable', 404);
      const row = await repository.item(itemId);
      if (!row) throw failure('Contenu introuvable', 404);
      const category = await repository.category(row.categoryId);
      if (!category || !category.isActive || category.editorialSource !== row.source || !sourceMatchesCategory(category)) throw failure('Contenu introuvable', 404);
      const state = await access(category, user);
      if (state.locked) throw failure(user ? 'Acces a cette analyse requis' : 'Authentification requise', user ? 403 : 401,
        !user ? 'AUTH_TOKEN_MISSING' : (category.isVip ? 'SUBSCRIPTION_REQUIRED' : 'RESOURCE_LOCKED'));
      const language = lang === 'en' ? 'en' : 'fr';
      return { ...row.payload, id: id(row), categoryId: id(category), locked: false, ...metadata(row.payload, language) };
    },
  };
}

function sourceMatchesCategory(category) {
  if (!category || category.isActive !== true || !category.editorialSource) return false;
  try { return !!validateCategorySource(category.editorialSource, category.isVip); } catch (_) { return false; }
}

let defaultService;
function getEditorialService() {
  if (!defaultService) defaultService = createEditorialService({ repository: require('./editorialRepository'),
    importEnabled: () => process.env.WINTIPS_EDITORIAL_IMPORT_ENABLED === 'true',
    requireEnglish: () => process.env.WINTIPS_EDITORIAL_REQUIRE_EN !== 'false',
    notifications: { enabled: () => require('./editorialNotifications').getEditorialNotifications().enabled(),
      drain: options => require('./editorialNotifications').getEditorialNotifications().drain(options) },
  });
  return defaultService;
}

module.exports = { createEditorialService, getEditorialService, sourceMatchesCategory, summary };
