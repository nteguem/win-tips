// src/api/services/push/providerRouter.js
//
// UN device -> UN provider -> UN message. Jamais les deux en parallèle.
// C'est la règle qui garantit l'absence de doublon pendant la cohabitation.

const JOUR = 864e5;

// Google : une registration inactive depuis "plus d'un mois" est stale
// ("Message sends and topic fanouts for these stale registrations are unlikely
// to ever be delivered"), et FCM renvoie alors un SUCCÈS apparent — l'échec est
// donc indétectable par code retour. Ramassage définitif à 270 jours.
// Google ne dit pas "28 jours" : 30 est notre approximation, assumée comme telle.
const STALE_JOURS = 30;
const GC_JOURS = 270;

function ageJours(date) {
  return date ? (Date.now() - new Date(date).getTime()) / JOUR : Infinity;
}

function fcmUtilisable(device) {
  return Boolean(device.fcmToken) && ageJours(device.fcmTokenUpdatedAt) < GC_JOURS;
}

function fcmFrais(device) {
  return fcmUtilisable(device) && ageJours(device.fcmTokenUpdatedAt) < STALE_JOURS;
}

/**
 * Bucket stable par device : un device tiré au sort dans le palier 5 % y reste
 * au palier 25 %. Sans cela, un device changerait de provider à chaque palier
 * (ping-pong) et fausserait la mesure.
 */
function bucketOf(deviceId) {
  let h = 0;
  for (let i = 0; i < String(deviceId).length; i++) {
    h = (h * 31 + String(deviceId).charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

/**
 * @param {Object} device
 * @param {Object} policy
 * @param {boolean} policy.oneSignalDisponible  false après le 01/10 sans plan payant
 * @param {number}  policy.rampPercent          0..100, palier de montée en charge
 * @param {'fcm'|'onesignal'} [policy.forceProvider]
 * @returns {{provider: 'fcm'|'onesignal'|null, reason: string}}
 */
function resolve(device, policy = {}) {
  const { oneSignalDisponible = true, rampPercent = 0, forceProvider = null } = policy;

  if (forceProvider) return { provider: forceProvider, reason: 'forced' };

  const osUtilisable = Boolean(device.playerId)
    && device.pushProvider !== 'unreachable'
    && oneSignalDisponible;

  const natif = device.fcmTokenSource === 'sdk' && fcmUtilisable(device);
  const pont = device.fcmTokenSource === 'onesignal_export' && fcmUtilisable(device);

  // 1. Token natif -> l'app est à jour, les canaux existent, le rendu est nominal.
  //    FCM sans condition, dès le premier jour.
  if (natif) return { provider: 'fcm', reason: 'token_natif' };

  // 2. Token issu du pont -> le rendu sera DÉGRADÉ sur une app non mise à jour :
  //    le manifeste pointe un canal qui n'existe pas, donc importance DEFAULT,
  //    pas de heads-up. Tant qu'OneSignal existe il rend mieux : on ne dégrade
  //    pas volontairement. On n'emprunte le pont que si OneSignal a disparu, ou
  //    si le device est dans le palier de montée en charge (pour mesurer avant
  //    de généraliser).
  if (pont && (!osUtilisable || bucketOf(device.deviceId) < rampPercent)) {
    return { provider: 'fcm', reason: 'pont' };
  }

  if (osUtilisable) return { provider: 'onesignal', reason: 'filet' };

  // 3. Dernier recours : un token stale vaut mieux que rien.
  if (device.fcmToken) return { provider: 'fcm', reason: 'dernier_recours' };

  return { provider: null, reason: 'unreachable' };
}

module.exports = { resolve, bucketOf, fcmFrais, fcmUtilisable, STALE_JOURS, GC_JOURS };
