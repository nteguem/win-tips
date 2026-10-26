const crypto = require('crypto');
const { preferredLanguage } = require('./devicePreferences');
const { sourceByKey, failure } = require('./editorialSources');
const { editionDateFor } = require('./editorialCalendar');
const { notificationSnapshot, digest } = require('./editorialCopy');

const id = value => String(value && value._id || value);
const terminal = new Set(['completed', 'no_audience', 'review_required']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function identity(appId, group) {
  return { appId, categoryId: id(group.category), source: group.source, editionDate: group.editionDate };
}
function notificationId(appId, group) {
  return 'editorial-' + crypto.createHash('sha256').update(JSON.stringify(identity(appId, group))).digest('hex').slice(0, 40);
}
function eventStart(item) {
  const values = item.kind === 'combine' ? (item.legs || []).map(leg => Date.parse(leg.startsAtUtc)) : [Date.parse(item.startsAtUtc)];
  return values.length && values.every(Number.isFinite) ? Math.min(...values) : NaN;
}
function eligibleItem(item, now) {
  return item.status === 'upcoming' && eventStart(item) >= now.getTime() + 30 * 60000 &&
    (item.kind !== 'combine' || item.legs.every(leg => leg.status === 'upcoming'));
}
function message(appId, group, language) {
  const date = new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }).format(new Date(group.editionDate + 'T12:00:00Z'));
  const labels = {
    rdj_petit_journal: { fr: `Le Petit Journal du ${date} est disponible`, en: `The ${date} Daily Journal is available` },
    rdj_turf_quinte: { fr: `Le Quinté du ${date} est disponible`, en: `The ${date} horse racing analysis is available` },
    rdj_football_analysis: { fr: `Les analyses foot du ${date} sont disponibles`, en: `The ${date} football analysis is available` },
    rdj_football_duo: { fr: `Le Duo du ${date} est disponible`, en: `The ${date} Daily Duo is available` },
    rdj_football_goals: { fr: `Le Combiné Buts du ${date} est disponible`, en: `The ${date} Goals Accumulator is available` },
    rdj_multisport_analysis: { fr: `Expert Multisports du ${date} est disponible`, en: `The ${date} Multisport Analysis is available` },
    rdj_football_combine: { fr: `Le combiné du ${date} est disponible`, en: `The ${date} accumulator is available` },
  };
  const names = group.items.flatMap(row => {
    const p = row.payload;
    if (p.kind === 'horse_racing') return [p.race.name + (p.race.racecourse ? ' · ' + p.race.racecourse : '')];
    return (p.kind === 'combine' ? p.legs : [p]).map(item => `${item.teams.home.name} — ${item.teams.away.name}`);
  });
  const body = (language === 'en' ? 'Analysis and statistics: ' : 'Analyses et statistiques : ') + names.join(' · ');
  const single = group.items.length === 1;
  return {
    id: notificationId(appId, group), title: labels[group.source][language], body: group.editorialCopy ? group.editorialCopy.body[language] : body.length > 180 ? body.slice(0, 177) + '…' : body,
    businessChannel: group.category.isVip ? 'vip' : 'tips', route: '/home', requiresVip: group.category.isVip === true,
    extra: { action: single ? 'view_editorial' : 'view_editorial_feed', ...(single ? { itemId: id(group.items[0]) } : {}),
      categoryId: id(group.category), isVip: group.category.isVip ? 'true' : 'false', editionDate: group.editionDate, language },
  };
}

function createEditorialNotificationService({ repository, push, clock = () => new Date(), appId = () => 'wintips',
  enabled = () => false, importEnabled = () => false, globallyDisabled = () => false, requireEnglish = () => true, budgetMs = 90000, maxBatches = 100 }) {
  const activated = () => appId() === 'wintips' && enabled() && importEnabled() && !globallyDisabled();
  async function recipients(category, devices) {
    let eligible = devices.filter(device => device.notificationsEnabled !== false && device.editorialSchemaVersion === 1);
    if (category.isVip) {
      const users = [...new Set(eligible.filter(device => device.user).map(device => id(device.user)))];
      const allowed = new Set((await repository.entitledUsers(id(category), users, clock())).map(id));
      eligible = eligible.filter(device => device.user && allowed.has(id(device.user)));
    }
    return eligible;
  }

  return {
    enabled: activated,
    async drain({ source, editionDate, dryRun = true } = {}) {
      if (typeof dryRun !== 'boolean') throw failure('dryRun doit etre un booleen');
      if (source !== undefined && !sourceByKey(source)) throw failure('Source editoriale inconnue');
      const now = clock(), date = editionDate || editionDateFor(now);
      if (!DAY.test(date) || date !== editionDateFor(now)) throw failure('Seule l edition du jour peut etre notifiee');
      if (appId() !== 'wintips') return { disabled: true, reason: 'wrong_app', sent: 0 };
      if (!dryRun && !activated()) return { disabled: true, reason: 'notifications_disabled', sent: 0 };
      const groups = (await repository.groups({ source, editionDate: date })).map(group => {
        // Notification text is rendered for each recipient language separately.
        // A missing or imperfect article translation must never silence it.
        const items = group.items.filter(row => eligibleItem(row.payload, now));
        const copy = group.editorialCopy;
        return { ...group, items, editorialCopy: copy && copy.choice.focusIds.every(sourceId => items.some(row => row.payload.sourceId === sourceId)) ? copy : null };
      }).filter(group => group.items.length);
      const report = { dryRun, groups: [], sent: 0, pending: 0 };
      const deadline = Date.now() + budgetMs;
      let batches = 0;
      for (const group of groups) {
        const key = identity(appId(), group), stableId = notificationId(appId(), group);
        const result = { source: group.source, categoryId: id(group.category), editionDate: date, notificationId: stableId, languages: { fr: 0, en: 0 } };
        if (dryRun) {
          let after = null;
          for (;;) {
            const devices = await repository.deviceBatch(after, 250); if (!devices.length) break;
            for (const device of await recipients(group.category, devices)) result.languages[preferredLanguage(device)]++;
            after = devices[devices.length - 1]._id;
            if (++batches >= maxBatches || Date.now() >= deadline) { result.truncated = true; break; }
          }
          result.status = 'preview'; report.groups.push(result); continue;
        }
        await repository.assertIndexes();
        let snapshot;
        try { snapshot = notificationSnapshot(group); }
        catch (_) { result.status = 'review_required'; report.groups.push(result); continue; }
        const claim = await repository.claim(key, stableId, now, snapshot);
        if (!claim) {
          // Preserve terminal review visibility on every hourly drain without
          // reclaiming or sending an already-finished notification again.
          const existing = await repository.ledgerState(key);
          result.status = terminal.has(existing?.status) ? existing.status : 'already_claimed_or_finished';
          if (terminal.has(existing?.status)) result.stats = existing.stats;
          report.groups.push(result); continue;
        }
        let after = claim.afterDeviceId || null, finished = false;
        try {
          // Old ledgers have no snapshot fields and keep their original generic
          // message. New claims cannot silently change copy/content on retry.
          const hasSnapshot = Object.prototype.hasOwnProperty.call(claim, 'itemHash');
          if (hasSnapshot && (typeof claim.itemHash !== 'string' || !/^[a-f0-9]{64}$/.test(claim.itemHash) || claim.itemHash !== snapshot.itemHash ||
            (claim.editorialCopy ? claim.editorialCopySha256 !== digest(claim.editorialCopy) : claim.editorialCopySha256 != null))) {
            throw failure('Contenu de notification modifie', 409, 'EDITORIAL_NOTIFICATION_SNAPSHOT_CHANGED');
          }
          const deliveryGroup = { ...group, editorialCopy: hasSnapshot ? claim.editorialCopy || null : null };
          while (batches < maxBatches && Date.now() < deadline && activated()) {
            if (editionDateFor(clock()) !== date || !group.items.every(row => eligibleItem(row.payload, clock()))) throw failure('Publication devenue trop tardive', 409);
            // Re-check the category before every batch: BO source changes and
            // deactivation must immediately stop a long-running delivery.
            if (!await repository.categoryStillMatches(key, group.category.isVip)) throw failure('Categorie editoriale modifiee', 409);
            const devices = await repository.deviceBatch(after, 250);
            if (!devices.length) { finished = true; break; }
            const targets = await recipients(group.category, devices);
            for (const language of ['fr', 'en']) {
              const deviceIds = targets.filter(device => preferredLanguage(device) === language).map(device => device.deviceId);
              if (!deviceIds.length) continue;
              if (!activated()) throw failure('Notifications desactivees', 409);
              const stats = await push(appId(), message(appId(), deliveryGroup, language), { targeting: { deviceIds }, retryFailures: true,
                respectNotificationPreferences: true, respectEditorialSchemaVersion: true });
              result.languages[language] += deviceIds.length;
              report.sent += (stats.fcm || 0) + (stats.onesignal || 0);
            }
            after = devices[devices.length - 1]._id;
            await repository.checkpoint(key, claim.lockToken, after, clock());
            batches++;
          }
          const stats = await repository.deliverySummary(appId(), stableId);
          const retryable = stats.retryable || 0;
          const status = !finished ? 'pending' : retryable && claim.passes < 5 ? 'retry_pending' :
            stats.uncertain || stats.failed || retryable ? 'review_required' : stats.accepted ? 'completed' : 'no_audience';
          await repository.finish(key, claim.lockToken, { status, afterDeviceId: status === 'retry_pending' ? null : after,
            nextAttemptAt: status === 'retry_pending' ? new Date(clock().getTime() + 15 * 60000) : null, stats }, clock());
          result.status = status; result.stats = stats;
          if (!terminal.has(status)) report.pending++;
        } catch (error) {
          // Keep the cursor before an ambiguous chunk. Stable per-device claims
          // exclude all accepted/queued messages on the next drain.
          const status = error.errorCode === 'EDITORIAL_NOTIFICATION_SNAPSHOT_CHANGED' ? 'review_required' : 'pending';
          await repository.finish(key, claim.lockToken, { status, lastErrorCode: String(error.errorCode || error.code || 'DELIVERY_INTERRUPTED').slice(0, 80) }, clock());
          result.status = status; if (status === 'pending') report.pending++;
        }
        report.groups.push(result);
      }
      return report;
    },
  };
}

let instance;
function getEditorialNotifications() {
  if (!instance) instance = createEditorialNotificationService({ repository: require('./editorialNotificationRepository').getEditorialNotificationRepository(),
    push: (appId, notification, options) => require('../push/pushService').send(appId, notification, { ...options,
      policy: { oneSignalDisponible: require('../push/appContext').oneSignalDisponible(),
        rampPercent: Math.max(0, Math.min(100, Number(process.env.PUSH_RAMP_PERCENT) || 0)) },
    }),
    appId: () => require('../push/appContext').appId(),
    enabled: () => process.env.WINTIPS_EDITORIAL_NOTIFICATIONS_ENABLED === 'true',
    importEnabled: () => process.env.WINTIPS_EDITORIAL_IMPORT_ENABLED === 'true',
    globallyDisabled: () => process.env.DISABLE_PUSH_NOTIFICATIONS === 'true',
    requireEnglish: () => process.env.WINTIPS_EDITORIAL_REQUIRE_EN !== 'false',
  });
  return instance;
}

module.exports = { createEditorialNotificationService, getEditorialNotifications, message, identity, notificationId, eligibleItem };
