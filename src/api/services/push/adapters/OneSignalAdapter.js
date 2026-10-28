// src/api/services/push/adapters/OneSignalAdapter.js
//
// Adapter de TRANSITION, en extinction. Il ne sert plus que de filet pour les
// devices sans token FCM exploitable, jusqu'au 30/09/2026 (org "proxi dream").
//
// Volontairement réduit à UN seul mode de ciblage : par subscription id explicite.
// Les segments ('All') et les filters (tag is_vip) sont abandonnés — l'audience
// est désormais résolue côté Mongo, ce qui la rend mesurable. `sendToAll` en
// included_segments empêchait précisément de savoir qui avait été touché.

const axios = require('axios');
const logger = require('../../../../utils/logger');
const { oneSignalTexts } = require('../localizedText');

const ONESIGNAL_API = 'https://onesignal.com/api/v1';

/**
 * @param {Object} appDoc       document App (getOneSignalConfig())
 * @param {Object} notification { id, title, body, route, requiresVip, extra }
 * @param {Array}  targets      [{ deviceId, playerId, msgId }]
 * @returns {Promise<Array<{deviceId, ok, code?, action}>>}
 */
async function send(appDoc, notification, targets) {
  if (!targets.length) return [];

  const cfg = appDoc.getOneSignalConfig();
  if (!cfg.appId || !cfg.restApiKey) {
    // Pas de config : rien n'est mort, c'est un problème d'infra -> retry.
    return targets.map((t) => ({ deviceId: t.deviceId, ok: false, code: 'onesignal_not_configured', action: 'retry' }));
  }

  // OneSignal plafonne include_player_ids à 2 000 destinataires par requête.
  const CHUNK = 2000;
  const out = [];

  for (let i = 0; i < targets.length; i += CHUNK) {
    const lot = targets.slice(i, i + CHUNK);
    try {
      const { data } = await axios.post(
        `${ONESIGNAL_API}/notifications`,
        {
          app_id: cfg.appId,
          include_player_ids: lot.map((t) => t.playerId),
          headings: oneSignalTexts(notification.title, 'Notification'),
          contents: oneSignalTexts(notification.body),
          data: {
            // Le msgId voyage aussi par OneSignal : c'est lui qui permet à l'app
            // de dédupliquer si jamais les deux canaux se croisaient.
            msgId: lot[0].msgId,
            notificationId: String(notification.id),
            route: notification.route || '',
            vip: notification.requiresVip ? 'true' : 'false',
            ...notification.extra,
          },
          small_icon: 'ic_stat_onesignal_default',
        },
        {
          headers: { Authorization: `Basic ${cfg.restApiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );

      // L'API ne donne QU'UN agrégat : aucun statut par destinataire.
      // C'est précisément pourquoi FCM est le canal primaire — lui renvoie
      // un code par token. Ici on ne peut que constater l'acceptation.
      const accepte = Boolean(data && data.id);
      out.push(...lot.map((t) => ({
        deviceId: t.deviceId,
        ok: accepte,
        code: accepte ? undefined : 'onesignal_rejected',
        action: accepte ? 'none' : 'retry',
      })));
    } catch (err) {
      const status = err.response?.status;
      logger.error('[push][onesignal] échec du lot', {
        appId: appDoc.appId,
        status,
        errors: err.response?.data?.errors,
      });
      // 403/410 = quota MAU dépassé ou app suspendue : OneSignal est mort,
      // le routeur basculera sur FCM au prochain passage. Rien à purger ici.
      out.push(...lot.map((t) => ({
        deviceId: t.deviceId,
        ok: false,
        code: `onesignal_http_${status || 'error'}`,
        action: 'retry',
        retrySafe: status === 429,
      })));
    }
  }

  return out;
}

module.exports = { send };
