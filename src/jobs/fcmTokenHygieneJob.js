// src/jobs/fcmTokenHygieneJob.js
//
// Hygiène des tokens FCM. Deux problèmes qu'AUCUN code d'erreur ne signale :
//
// 1. Les registrations "stale". Google : au-delà d'un mois d'inactivité,
//    "Message sends and topic fanouts for these stale registrations are unlikely
//    to ever be delivered" — et FCM renvoie un SUCCÈS apparent. On ne peut donc
//    les détecter que par le TEMPS, jamais par la réponse d'envoi. C'est
//    exactement ce qui faisait croire à l'ancien code que tout partait bien.
//
// 2. Les tokens issus du pont d'export OneSignal ne sont rafraîchis que par le
//    SDK OneSignal. Le jour où il est retiré des builds, ces tokens vieillissent
//    sans que rien ne les renouvelle, jusqu'au ramassage FCM à 270 jours.
//
// Le job ne SUPPRIME rien : il rétrograde le pushProvider pour que le routeur
// cesse de compter ces devices comme joignables, et remonte des métriques
// honnêtes. Un device qui rouvre l'app repasse en 'fcm' via /devices/register.

const cron = require('node-cron');
const logger = require('../utils/logger');
const Device = require('../api/models/common/Device');
const { GC_JOURS } = require('../api/services/push/providerRouter');

const JOUR = 864e5;

class FcmTokenHygieneJob {
  constructor() {
    this.cronJob = null;
    this.isRunning = false;
    // 01h30 UTC, après la réconciliation des tags (00h05) et avant la
    // campagne de rétention du matin (09h00 UTC = 10h Cameroun).
    this.cronExpression = '30 1 * * *';
    this.stats = { lastRun: null, totalRuns: 0, lastError: null, lastResult: null };
  }

  async start() {
    if (this.cronJob) return;
    this.cronJob = cron.schedule(this.cronExpression, () => this.run(), { scheduled: true });
    logger.info(`[fcm-hygiene] planifié (${this.cronExpression} UTC)`);
  }

  stop() {
    if (this.cronJob) { this.cronJob.stop(); this.cronJob = null; }
  }

  async run() {
    if (this.isRunning) {
      logger.warn('[fcm-hygiene] exécution précédente encore en cours, on saute');
      return;
    }
    this.isRunning = true;
    const t0 = Date.now();

    try {
      const limiteGc = new Date(Date.now() - GC_JOURS * JOUR);

      // Tokens au-delà du ramassage FCM : définitivement inutilisables.
      // On rétrograde sur le filet OneSignal s'il reste un playerId.
      const perimes = await Device.updateMany(
        { fcmToken: { $type: 'string' }, fcmTokenUpdatedAt: { $lt: limiteGc }, playerId: { $type: 'string' } },
        {
          $unset: { fcmToken: '', fcmTokenSource: '', fcmTokenUpdatedAt: '' },
          $set: { pushProvider: 'onesignal', lastPushError: { code: 'expired_270d', at: new Date() } },
        }
      );

      const perimesSansFilet = await Device.updateMany(
        { fcmToken: { $type: 'string' }, fcmTokenUpdatedAt: { $lt: limiteGc }, playerId: { $exists: false } },
        {
          $unset: { fcmToken: '', fcmTokenSource: '', fcmTokenUpdatedAt: '' },
          $set: { pushProvider: 'unreachable', lastPushError: { code: 'expired_270d', at: new Date() } },
        }
      );

      // Tokens hérités : présents en base mais sans `fcmTokenUpdatedAt`, donc
      // d'âge inconnu. En pratique ce sont les 599 devices d'août 2025, restes
      // d'une première tentative FCM abandonnée : ils n'ont jamais eu de
      // playerId et leurs tokens dépassent largement les 270 jours de FCM.
      // Sans cette règle, providerRouter les classe en « dernier recours » et
      // les envois partent vers des tokens morts.
      const herites = await Device.updateMany(
        { fcmToken: { $type: 'string' }, fcmTokenUpdatedAt: { $exists: false } },
        {
          $unset: { fcmToken: '', fcmTokenSource: '' },
          $set: { lastPushError: { code: 'legacy_token_sans_date', at: new Date() } },
        }
      );

      // Devices sans aucun moyen de contact : marqués honnêtement au lieu
      // d'être comptés dans l'audience. C'est ce que countAudience() ne faisait
      // pas — il estimait "devices = users" quand la collection était vide.
      const orphelins = await Device.updateMany(
        {
          isActive: true,
          pushProvider: { $ne: 'unreachable' },
          fcmToken: { $exists: false },
          $or: [{ playerId: { $exists: false } }, { playerId: null }],
        },
        { $set: { pushProvider: 'unreachable' } }
      );

      const resultat = {
        expiresAvecFilet: perimes.modifiedCount,
        expiresSansFilet: perimesSansFilet.modifiedCount,
        tokensHerites: herites.modifiedCount,
        orphelins: orphelins.modifiedCount,
        dureeMs: Date.now() - t0,
      };

      this.stats = {
        lastRun: new Date(), totalRuns: this.stats.totalRuns + 1,
        lastError: null, lastResult: resultat,
      };
      logger.info('[fcm-hygiene] terminé', resultat);
      return resultat;
    } catch (err) {
      this.stats.lastError = err.message;
      logger.error('[fcm-hygiene] échec', { message: err.message });
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Photographie de la joignabilité, par constructeur.
   * C'est le tableau de bord qui remplace celui de OneSignal — et qui, lui,
   * dit la vérité.
   *
   * Mono-tenant : pas de ventilation par app, chaque base ne contenant que ses
   * propres devices. Le total global remplace le groupement par appId.
   */
  async report() {
    const global = await Device.aggregate([
      { $match: { isActive: true } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        fcm: { $sum: { $cond: [{ $eq: [{ $type: '$fcmToken' }, 'string'] }, 1, 0] } },
        natif: { $sum: { $cond: [{ $eq: ['$fcmTokenSource', 'sdk'] }, 1, 0] } },
        pont: { $sum: { $cond: [{ $eq: ['$fcmTokenSource', 'onesignal_export'] }, 1, 0] } },
        injoignables: { $sum: { $cond: [{ $eq: ['$pushProvider', 'unreachable'] }, 1, 0] } },
      } },
      { $sort: { total: -1 } },
    ]);

    const parConstructeur = await Device.aggregate([
      { $match: { isActive: true, fcmToken: { $type: 'string' } } },
      { $group: { _id: '$manufacturer', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);

    return { global: global[0] || null, parConstructeur };
  }
}

module.exports = new FcmTokenHygieneJob();
