const crypto = require('crypto');
const { SOURCES, sourceByKey, validateCategorySource, failure } = require('./editorialSources');
const { validateBatch, dateOnly, hasCompleteEnglish, requireCompleteEnglish } = require('./editorialValidation');
const { editionDateFor } = require('./editorialCalendar');

const pickLang = (value, lang) => typeof value === 'string' ? value : (value && (value[lang] || value.fr || value.en)) || '';
const id = value => String(value && value._id || value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

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
      return { date: editionDateFor(clock()), importEnabled: !!importEnabled(), notificationsEnabled: !!(notifications && notifications.enabled()), requireEnglish: !!requireEnglish(),
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
