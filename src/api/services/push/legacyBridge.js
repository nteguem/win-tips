// src/api/services/push/legacyBridge.js
//
// Traduction entre le format historique OneSignal (utilisé par ~15 appelants,
// dont les hooks Mongoose de Ticket.js qui sont le chemin le plus chaud du
// produit) et le format interne de pushService.
//
// Objectif : que notificationService puisse déléguer à pushService SANS QU'AUCUN
// APPELANT NE CHANGE. Les appelants lisent `r.id` et `r.recipients` : la réponse
// renvoyée imite donc celle de OneSignal.

const crypto = require('crypto');

// data.type (format historique) -> canal métier Android.
// Les canaux doivent exister côté app ; un canal inconnu ici retombe sur 'tips'.
const TYPE_TO_CHANNEL = {
  ticket: 'tips',
  live: 'tips',
  daily_coupon: 'tips',
  premium: 'vip',
  payment_success: 'system',
  payment_failed: 'system',
  payment_issue: 'system',
  promotion: 'promo',
  retention: 'promo',
};

// data.action -> route go_router. L'app sait déjà router sur `action` via
// NotificationAction ; on transmet les deux pour ne rien casser.
const ACTION_TO_ROUTE = {
  view_ticket: '/home',
  view_predictions: '/home',
  view_live: '/live',
  view_daily_coupon: '/home',
  view_subscription: '/subscription',
  retry_payment: '/subscription',
};

/** Prend la version française si elle existe, sinon l'anglaise, sinon la chaîne brute. */
function pickText(value, fallback = '') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  return value.fr || value.en || Object.values(value)[0] || fallback;
}

/**
 * Convertit une notification au format OneSignal historique vers le format pushService.
 *
 * @param {Object} legacy { headings, contents, data, options }
 * @param {String} [notificationId] identifiant stable ; généré si absent
 */
function toPushNotification(legacy = {}, notificationId = null) {
  const data = legacy.data || {};
  const type = data.type || 'ticket';
  const opts = legacy.options || {};

  // L'identifiant doit être STABLE pour que l'idempotence fonctionne : deux
  // déclenchements du même hook Mongoose sur le même ticket doivent produire
  // le même id, sinon le verrou ne sert à rien. On le dérive du contenu.
  // Explicit publication IDs survive wording and language changes. Preserve
  // the historical content-derived ID for callers that supply no event ID.
  const id = notificationId || data.notificationId || opts.idempotency_key || legacy.id || crypto.createHash('sha1')
    .update(JSON.stringify({
      t: pickText(legacy.headings),
      c: pickText(legacy.contents),
      d: data,
    }))
    .digest('base64url')
    .slice(0, 22);

  return {
    id,
    title: legacy.headings || 'Notification',
    body: legacy.contents || '',
    businessChannel: TYPE_TO_CHANNEL[type] || 'tips',
    route: ACTION_TO_ROUTE[data.action] || '',
    requiresVip: type === 'premium' || data.vip === true || data.vip === 'true',
    // La couleur est stockée sans '#' en base ; payloadBuilder la normalise.
    color: opts.android_accent_color,
    icon: opts.small_icon,
    // Tout le reste du payload métier passe tel quel : l'app le lit déjà
    // via NotificationAction.fromJson(additionalData).
    extra: data,
  };
}

/**
 * Imite la réponse de l'API OneSignal pour que les appelants existants
 * (`r.id`, `r.recipients`) continuent de fonctionner sans modification.
 *
 * Différence de fond, et c'est une amélioration : `recipients` vaut ici le
 * nombre d'envois RÉELLEMENT acceptés par le transport, alors que le code
 * historique comptait tout envoi accepté par OneSignal comme réussi
 * (notificationService.js:972, `const queued = response.id ? requested : 0`).
 */
function toLegacyResponse(notificationId, stats) {
  return {
    id: notificationId,
    recipients: stats.dryRun ? 0 : (stats.fcm || 0) + (stats.onesignal || 0),
    // Champs supplémentaires, ignorés par les appelants historiques mais
    // précieux pour le pilotage de la bascule.
    _stats: stats,
  };
}

module.exports = { toPushNotification, toLegacyResponse, pickText, TYPE_TO_CHANNEL, ACTION_TO_ROUTE };
