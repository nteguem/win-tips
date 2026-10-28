// src/api/services/push/pushService.js
//
// Porte unique de l'envoi push. Orchestre : résolution d'audience (Mongo) ->
// routage par device -> réclamation d'idempotence -> envoi -> application des
// résultats (purge des tokens morts, rétrogradation du provider).
//
// Ce service NE remplace PAS notificationService.js. Les points d'appel les plus
// chauds sont des hooks Mongoose (Ticket.js post('findOneAndUpdate') l.223/239/253,
// correctAndNotifyService.js l.331 et 410) : on garde leur signature publique et
// notificationService délègue ici.

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { appDoc: contexteApp, oneSignalDisponible } = require('./appContext');
const Device = require('../../models/common/Device');
const PushDelivery = require('../../models/common/PushDelivery');
const providerRouter = require('./providerRouter');
const FcmAdapter = require('./adapters/FcmAdapter');
const OneSignalAdapter = require('./adapters/OneSignalAdapter');

// Curseur : on ne charge JAMAIS 23 000 devices en RAM d'un coup.
const AUDIENCE_BATCH = 1000;

/** Clé d'idempotence stable, indépendante du provider et du nombre de tentatives. */
function buildMsgId(notificationId, deviceId) {
  return crypto.createHash('sha1')
    .update(`${notificationId}:${deviceId}`)
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Réclame la livraison pour UN device. L'index unique sur msgId fait le travail :
 * deux workers concurrents, un cron qui se chevauche ou un double hook Mongoose
 * ne produisent qu'un seul envoi.
 *
 * À n'utiliser que pour un envoi unitaire : un aller-retour par device rend
 * l'envoi de masse inexploitable (mesuré : ~930 devices en plus de 7 minutes
 * sur Atlas distant). Pour un lot, utiliser claimMany().
 *
 * @returns {Promise<string|null>} msgId si réclamée, null si déjà traitée
 */
async function claim(appId, notificationId, deviceId, provider) {
  const msgId = buildMsgId(notificationId, deviceId);
  try {
    await PushDelivery.create({ msgId, appId, notificationId, deviceId, provider });
    return msgId;
  } catch (err) {
    if (err.code === 11000) return null; // déjà réclamée -> on n'envoie pas
    throw err;
  }
}

/**
 * Réclamation par lot : UN aller-retour pour N devices au lieu de N.
 *
 * `insertMany(ordered: false)` insère tout ce qui passe et lève une erreur
 * agrégée listant les index en échec. Les doublons (code 11000) sont exactement
 * les livraisons déjà réclamées ailleurs : on les écarte, on garde le reste.
 *
 * @param {Array<{deviceId, provider}>} items
 * @returns {Promise<Map<string,string>>} deviceId -> msgId, pour les seules réclamées
 */
async function claimMany(appId, notificationId, items, { retryFailures = false } = {}) {
  if (!items.length) return new Map();

  const docs = items.map((it) => ({
    msgId: buildMsgId(notificationId, it.deviceId),
    appId,
    notificationId,
    deviceId: it.deviceId,
    provider: it.provider,
  }));

  const refuses = new Set();
  try {
    await PushDelivery.insertMany(docs, { ordered: false });
  } catch (err) {
    const erreurs = err.writeErrors || err.result?.result?.writeErrors || [];
    for (const we of erreurs) {
      const code = we.code ?? we.err?.code;
      const index = we.index ?? we.err?.index;
      if (code === 11000) refuses.add(index);
      else throw err; // autre chose qu'un doublon : on ne masque pas
    }
    if (!erreurs.length) throw err;
  }

  const out = new Map();
  docs.forEach((d, i) => { if (!refuses.has(i)) out.set(d.deviceId, d.msgId); });
  if (retryFailures) {
    // Opt-in for the editorial drain only. The compare-and-set prevents two
    // drains from reclaiming the same confirmed rejection concurrently.
    for (const i of refuses) {
      const d = docs[i];
      const reclaimed = await PushDelivery.findOneAndUpdate({
        msgId: d.msgId, appId, notificationId, status: 'failed', retrySafe: true,
        nextRetryAt: { $lte: new Date() }, attempts: { $lt: 5 },
        ackAt: null, sentAt: null,
      }, { $set: { status: 'queued', retrySafe: false }, $inc: { attempts: 1 } }, { new: true });
      if (reclaimed) out.set(d.deviceId, d.msgId);
    }
  }
  return out;
}

/**
 * Construit le filtre Mongo d'audience. Remplace included_segments:['All'] et
 * les filters par tag : l'audience devient comptable et mesurable.
 * @param {Object} targeting { appId, audience: 'all'|'vip'|'free', countryCodes }
 */
function audienceFilter({ appId, audience = 'all', userTypes, playerIds, deviceIds, userIds, respectNotificationPreferences = false, respectEditorialSchemaVersion = false } = {}) {
  // Pas de filtre sur appId : ce backend est mono-tenant, chaque base ne
  // contient que ses propres devices et la collection n'a pas ce champ.
  // Le porter ici ne remonterait jamais personne.
  const f = { isActive: true, pushProvider: { $ne: 'unreachable' } };
  if (respectNotificationPreferences) f.notificationsEnabled = { $ne: false };
  if (respectEditorialSchemaVersion) f.editorialSchemaVersion = 1;

  // Ciblage EXPLICITE : l'appelant nomme ses destinataires (confirmation de
  // paiement, expiration d'abonnement…). On ne lui applique pas le filtre de
  // joignabilité ci-dessous : s'il demande ce device, on tente ce device.
  if (playerIds) { f.playerId = { $in: playerIds }; return f; }
  if (deviceIds) { f.deviceId = { $in: deviceIds }; return f; }
  if (userIds) { f.user = { $in: userIds }; return f; }

  // À partir d'ici, on est en diffusion large.
  // Exiger un signal POSITIF de joignabilité, et non l'absence de signal négatif.
    //
    // Mesuré en production le 23/09/2026 : sans cette clause, l'audience de bigwin
    // remontait à 88 478 devices pour 10 242 abonnés réels. La collection contient
    // ~78 000 enregistrements anciens qui ont un playerId mais dont l'abonnement
    // est mort depuis longtemps — ils n'ont aucun `pushProvider` (champ créé par
    // cette migration) et ne sont pas issus de l'import.
    //
    // L'ancien code s'en remettait à `included_segments:['All']`, et c'est OneSignal
    // qui filtrait de son côté. En résolvant l'audience nous-mêmes, ce filtrage
    // devient notre responsabilité : on arroserait 4x trop de monde, en 50 appels
    // API au lieu d'un.
    //
  // Sont retenus : les devices porteurs d'un token FCM, et ceux dont le
  // pushProvider a été explicitement posé (import ou /devices/register).
  f.$or = [
    { fcmToken: { $type: 'string' } },
    { pushProvider: { $in: ['onesignal', 'both', 'fcm'] } },
  ];

  if (audience === 'vip') f.userType = 'vip';
  else if (audience === 'free') f.userType = { $in: ['guest', 'registered'] };
  if (userTypes) f.userType = { $in: userTypes };
  return f;
}

/**
 * Applique les résultats d'envoi : purge des tokens définitivement morts,
 * rétrogradation du provider, journalisation.
 *
 * On ne rétrograde JAMAIS sur une erreur transitoire (429/503/500) : la
 * retentative aboutirait et produirait un doublon.
 */
async function applyResults(appId, results) {
  const morts = results.filter((r) => r.action === 'drop_token').map((r) => r.deviceId);
  const ops = [];

  // Un seul aller-retour pour connaître les playerId des devices à rétrograder,
  // au lieu d'un findOne par device.
  const playerIds = new Map();
  if (morts.length) {
    const docs = await Device.find(
      { deviceId: { $in: morts } },
      { deviceId: 1, playerId: 1 }
    ).lean();
    docs.forEach((d) => playerIds.set(d.deviceId, d.playerId));
  }

  for (const r of results) {
    if (r.ok) {
      ops.push({
        updateOne: {
          filter: { deviceId: r.deviceId },
          update: { $unset: { lastPushError: '' }, $set: { lastActiveAt: new Date() } },
        },
      });
      continue;
    }
    if (r.action !== 'drop_token') continue; // 'retry' : on ne touche à rien

    // Sémantique de Device.markTokenDead(), répliquée en bulkWrite pour le volume.
    ops.push({
      updateOne: {
        filter: { deviceId: r.deviceId },
        update: {
          $unset: { fcmToken: '', fcmTokenSource: '', fcmTokenUpdatedAt: '' },
          $set: {
            pushProvider: playerIds.get(r.deviceId) ? 'onesignal' : 'unreachable',
            lastPushError: { code: r.code, at: new Date() },
          },
        },
      },
    });
  }

  if (ops.length) await Device.bulkWrite(ops, { ordered: false });

  // Statut de livraison, pour le pilotage de la bascule.
  const deliveryOps = results.map((r) => ({
    updateOne: {
      // An ACK may arrive before the provider response has been persisted.
      // Never overwrite that stronger delivery state with sent/failed.
      filter: { deviceId: r.deviceId, msgId: r.msgId, status: { $ne: 'acked' } },
      update: {
        $set: {
          status: r.ok ? 'sent' : 'failed',
          code: r.code,
          retrySafe: !r.ok && r.retrySafe === true,
          nextRetryAt: !r.ok && r.retrySafe === true ? new Date(Date.now() + 15 * 60000) : null,
          sentAt: r.ok ? new Date() : undefined,
        },
      },
    },
  })).filter((o) => o.updateOne.filter.msgId);
  if (deliveryOps.length) await PushDelivery.bulkWrite(deliveryOps, { ordered: false });
}

/**
 * Envoi principal.
 *
 * @param {string} appId
 * @param {Object} notification { id, title, body, businessChannel, route, requiresVip, extra }
 * @param {Object} [options]
 * @param {Object} [options.targeting] { audience, userTypes }
 * @param {Object} [options.policy]    { oneSignalDisponible, rampPercent, forceProvider }
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{fcm, onesignal, skipped, unreachable, failed}>}
 */
async function send(appId, notification, options = {}) {
  const { targeting = {}, policy = {}, dryRun = false } = options;

  // Garde-fou repris de notificationService._getConfig() : en dev/staging (copies
  // de la prod réutilisant les mêmes credentials), DISABLE_PUSH_NOTIFICATIONS=true
  // coupe tout envoi réel. Sans cela, un script de test lancé depuis un poste de
  // développement arrose les vrais utilisateurs.
  const coupe = process.env.DISABLE_PUSH_NOTIFICATIONS === 'true';
  const effectiveDryRun = dryRun || coupe;
  if (coupe && !dryRun) {
    logger.warn(`[push][${appId}] DISABLE_PUSH_NOTIFICATIONS=true -> forcé en dryRun`);
  }

  // Mono-tenant : le « document App » est synthetise depuis l'environnement.
  const appDoc = contexteApp();

  const notificationId = String(notification.id || crypto.randomUUID());
  const resolvedPolicy = {
    oneSignalDisponible: policy.oneSignalDisponible !== false,
    rampPercent: policy.rampPercent ?? 0,
    forceProvider: policy.forceProvider || null,
  };

  const stats = { fcm: 0, onesignal: 0, skipped: 0, unreachable: 0, failed: 0, dryRun: effectiveDryRun };
  const cursor = Device.find(audienceFilter({ appId, ...targeting, respectNotificationPreferences: options.respectNotificationPreferences === true,
    respectEditorialSchemaVersion: options.respectEditorialSchemaVersion === true }))
    .select('deviceId playerId fcmToken fcmTokenSource fcmTokenUpdatedAt pushProvider language deviceLanguage')
    .lean()
    .cursor();

  // On accumule un lot de devices ROUTÉS, puis on réclame en une seule fois
  // avant d'envoyer. La réclamation reste le verrou anti-doublon, mais elle
  // coûte un aller-retour par LOT au lieu d'un par device.
  let buf = [];
  // Historical aliases can share one physical push endpoint. Deduplicate for
  // the entire cursor, not only inside a batch, before reserving deliveries.
  const seenTokens = new Set();
  const seenPlayers = new Set();

  const flush = async (force = false) => {
    if (!buf.length || (!force && buf.length < AUDIENCE_BATCH)) return;
    const lot = buf;
    buf = [];

    // A validation pass must not consume claims or mark simulated sends sent.
    const claimed = effectiveDryRun
      ? new Map(lot.map((device) => [device.deviceId, buildMsgId(notificationId, device.deviceId)]))
      : await claimMany(appId, notificationId, lot, { retryFailures: options.retryFailures === true });
    stats.skipped += lot.length - claimed.size;

    const cibles = lot
      .filter((d) => claimed.has(d.deviceId))
      .map((d) => ({ ...d, msgId: claimed.get(d.deviceId) }));

    const bufFcm = cibles.filter((d) => d.provider === 'fcm');
    const bufOs = cibles.filter((d) => d.provider === 'onesignal');

    // Correspondance par deviceId et non par index : un adapter qui reordonne
    // ou omet un resultat ne doit pas decaler les msgId, sinon on marquerait
    // la mauvaise livraison et on purgerait le mauvais token.
    const msgIdParDevice = new Map(cibles.map((c) => [c.deviceId, c.msgId]));

    if (bufFcm.length) {
      const res = await FcmAdapter.send(appDoc, { ...notification, id: notificationId }, bufFcm, { dryRun: effectiveDryRun });
      res.forEach((r) => { r.msgId = msgIdParDevice.get(r.deviceId); });
      if (!effectiveDryRun) await applyResults(appId, res);
      stats.fcm += res.filter((r) => r.ok).length;
      stats.failed += res.filter((r) => !r.ok).length;
    }
    if (bufOs.length) {
      const res = effectiveDryRun
        ? bufOs.map((t) => ({ deviceId: t.deviceId, ok: true, action: 'none', msgId: t.msgId }))
        : await OneSignalAdapter.send(appDoc, { ...notification, id: notificationId }, bufOs);
      res.forEach((r) => { r.msgId = msgIdParDevice.get(r.deviceId); });
      if (!effectiveDryRun) await applyResults(appId, res);
      stats.onesignal += res.filter((r) => r.ok).length;
      stats.failed += res.filter((r) => !r.ok).length;
    }
  };

  for await (const device of cursor) {
    const { provider } = providerRouter.resolve(device, resolvedPolicy);
    if (!provider) { stats.unreachable++; continue; }
    if ((device.fcmToken && seenTokens.has(device.fcmToken)) ||
        (device.playerId && seenPlayers.has(device.playerId))) {
      stats.skipped++;
      continue;
    }
    if (device.fcmToken) seenTokens.add(device.fcmToken);
    if (device.playerId) seenPlayers.add(device.playerId);
    buf.push({ ...device, provider });
    await flush();
  }
  await flush(true);

  logger.info(`[push][${appId}] notification ${notificationId} envoyée`, stats);
  return stats;
}

module.exports = { send, claim, claimMany, buildMsgId, audienceFilter, applyResults };
