// src/api/services/push/payloadBuilder.js
//
// Une notification métier -> un message FCM. Concentre tous les pièges de format.

const { createHash } = require('node:crypto');
const { notificationText } = require('./localizedText');

// Canaux Android par type métier. Ils doivent exister CÔTÉ APP (créés en Kotlin au
// démarrage) ; un canal déclaré ici mais absent de l'app fait retomber Android sur
// le canal de repli de FCM, en importance DEFAULT : pas de heads-up, souvent pas de son.
const CHANNEL_BY_TYPE = {
  vip: 'vip_v1',
  tips: 'tips_v1',
  results: 'results_v1',
  promo: 'promo_v1',
  system: 'system_v1',
};

// TTL en MILLISECONDES : c'est ce qu'attend AndroidConfig.ttl du SDK firebase-admin.
// L'API REST v1, elle, attend une chaîne en secondes ("3600s"). L'erreur est
// silencieuse et donne un TTL 1000x trop court ou trop long.
const TTL_MS = {
  vip: 6 * 3600e3,
  tips: 12 * 3600e3,
  results: 24 * 3600e3,
  promo: 24 * 3600e3,
  system: 7 * 86400e3,
};

/**
 * FCM refuse tout ce qui n'est pas une string dans `data` (INVALID_ARGUMENT).
 * Le baseData actuel de notificationService contient targetCountries (tableau)
 * et batchNumber (nombre) : sans ce passage, échec certain au premier envoi.
 */
function stringifyData(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string'
      ? v
      : (Array.isArray(v) || typeof v === 'object') ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * La couleur d'accent est stockée SANS '#' en base ('FFD700', 'F59E0B'…).
 * FCM exige le format #RRGGBB et rejette le reste en INVALID_ARGUMENT.
 */
function normalizeColor(color) {
  if (!color) return undefined;
  const c = String(color).trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(c) ? `#${c}` : undefined;
}

// Android replaces an already displayed notification with the same tag.
// collapseKey only merges messages still waiting at FCM. Keep the native tag
// tied to the event, not translated text or the endpoint's delivery msgId.
function androidNotificationTag(notificationId) {
  if (notificationId === null || notificationId === undefined) return undefined;
  const identity = String(notificationId).trim();
  if (!identity) return undefined;
  return `wt-event-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

/**
 * Payload HYBRIDE (notification + data) et NON data-only.
 *
 * Raison propre à ce parc : 82 % (Cameroun) à 87 % (Côte d'Ivoire) des appareils
 * tournent sur un OEM tueur d'apps. Un payload data-only impose de démarrer un
 * isolate Dart pour CHAQUE notification, process froid compris — précisément ce
 * que ces surcouches bloquent ("frozen in time" sur Transsion, sans solution
 * développeur). Le bloc `notification` est rendu par le SDK natif, sans Dart.
 *
 * Contrepartie OBLIGATOIRE côté app : le handler Dart ne doit JAMAIS réafficher
 * un message porteur d'un bloc `notification`, sinon doublon systématique.
 *
 * @param {Object} notification { id, title, body, businessChannel, route, requiresVip, extra, icon, color }
 * @param {Object} target       { deviceId, fcmToken, fcmTokenSource, msgId }
 */
function buildFcmMessage(notification, target) {
  const type = notification.businessChannel || 'tips';
  const tag = androidNotificationTag(notification.id);
  const text = notificationText(notification, target);

  return {
    token: target.fcmToken,

    notification: {
      title: text.title,
      body: text.body,
    },

    data: stringifyData({
      route: notification.route || '',
      vip: notification.requiresVip ? 'true' : 'false',
      type,
      ack: '1',
      ...notification.extra,
      // Business data must never override the durable delivery/event identity.
      msgId: target.msgId,
      notificationId: String(notification.id),
    }),

    android: {
      // Le défaut FCM est NORMAL, pour les payloads notification comme data.
      // Sans cette ligne la livraison est différée en Doze — exactement le
      // symptôme qu'on cherche à supprimer.
      priority: type === 'promo' ? 'normal' : 'high',

      ttl: TTL_MS[type] ?? TTL_MS.tips,

      // collapse_key = le CANAL MÉTIER, pas le msgId. Un msgId est unique par
      // message : l'utiliser ne collapserait jamais rien. FCM ne retient que
      // 4 clés par appareil et évince les autres sans règle documentée.
      collapseKey: type,

      notification: {
        // Omit a tag when the caller has no event identity: unrelated messages
        // must never replace one another under a shared "undefined" identity.
        ...(tag ? { tag } : {}),
        // Les 5 densités de ic_stat_onesignal_default.png existent déjà dans les
        // 7 APK et sont des silhouettes alpha valides : réutilisables tel quel.
        // C'est la seule des deux régressions d'affichage réparable côté serveur.
        icon: notification.icon || 'ic_stat_onesignal_default',
        color: normalizeColor(notification.color),
        channelId: CHANNEL_BY_TYPE[type] || CHANNEL_BY_TYPE.tips,
        // PAS de clickAction ici. Mesure sur un Redmi le 23/09/2026 : avec
        // `clickAction: 'FLUTTER_NOTIFICATION_CLICK'`, le clic sur la
        // notification ne faisait STRICTEMENT RIEN — l'app ne s'ouvrait meme
        // pas. Android cherche alors une activite declarant un intent-filter
        // pour cette action, n'en trouve aucune dans nos 7 manifestes, et
        // abandonne le clic.
        //
        // FLUTTER_NOTIFICATION_CLICK est un vestige des vieilles versions de
        // firebase_messaging. Depuis la v14, le plugin intercepte le tap par
        // defaut : sans clickAction, Android lance l'activite principale et
        // firebase_messaging declenche onMessageOpenedApp / getInitialMessage
        // avec le `data` du message.
        //
        // Corrige cote SERVEUR volontairement : ajouter l'intent-filter aux 7
        // manifestes aurait impose de republier les 7 apps pour reparer le
        // clic. Ici, une seule ligne retiree repare les 7 d'un coup, y compris
        // les binaires deja installes.
      },
    },
  };
}

module.exports = { buildFcmMessage, stringifyData, normalizeColor, CHANNEL_BY_TYPE, TTL_MS };
