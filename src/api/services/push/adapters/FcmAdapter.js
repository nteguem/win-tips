// src/api/services/push/adapters/FcmAdapter.js

const { getMessagingFor } = require('../firebaseApps');
const { buildFcmMessage } = require('../payloadBuilder');

// Erreurs DÉFINITIVES : le token ne sera plus jamais valide. On purge, jamais de retry.
const DEAD = new Set([
  'messaging/registration-token-not-registered', // UNREGISTERED 404
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-found',
  'messaging/mismatched-credential',             // SENDER_ID_MISMATCH 403
  'messaging/sender-id-mismatch',                // alias selon la version du SDK
  'messaging/invalid-argument',                  // 400
]);

// Erreurs TRANSITOIRES : on ne touche NI au token NI au provider, on retente en backoff.
// Rétrograder ici produirait un doublon dès que la retentative aboutit.
// C'est la règle la plus importante du dispositif.
const RETRY = new Set([
  'messaging/server-unavailable',  // 503 UNAVAILABLE
  'messaging/internal-error',      // 500 INTERNAL
  'messaging/quota-exceeded',      // 429 QUOTA_EXCEEDED
  'messaging/too-many-requests',   // 429
  'messaging/unknown-error',
  'messaging/third-party-auth-error', // 401 : problème de credentials APNs/FCM, pas le token
]);

// Bug firebase-admin #2943 (ouvert le 24/06/2025, toujours OPEN au 22/09/2026) :
// "GOAWAY - exceeded_max_concurrent_streams, Error code: 1" dès ~214 tokens.
// Le problème est le nombre de STREAMS HTTP/2 SIMULTANÉS, pas la taille du lot :
// sendEach ouvre un stream par message. CHUNK x concurrence doit rester sous ~150.
// Les lots sont traités SÉQUENTIELLEMENT : 100 streams en vol, jamais plus.
// À 23 000 devices cela fait 230 appels, soit ~2 minutes. La concurrence est inutile.
const CHUNK = 100;

/**
 * @param {Object} appDoc       document App portant la config firebase
 * @param {Object} notification { id, title, body, businessChannel, route, requiresVip, extra }
 * @param {Array}  targets      [{ deviceId, fcmToken, fcmTokenSource, msgId }]
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] valide la requête sans rien livrer
 * @returns {Promise<Array<{deviceId, ok, messageId?, code?, action}>>}
 *          action ∈ 'none' | 'drop_token' | 'retry'
 */
async function send(appDoc, notification, targets, { dryRun = false } = {}) {
  if (!targets.length) return [];
  const messaging = getMessagingFor(appDoc);
  const out = [];

  for (let i = 0; i < targets.length; i += CHUNK) {
    const lot = targets.slice(i, i + CHUNK);
    let batch;

    try {
      // sendAll() et sendMulticast() ont été SUPPRIMÉS en firebase-admin v13.0.0.
      batch = await messaging.sendEach(
        lot.map((t) => buildFcmMessage(notification, t)),
        dryRun
      );
    } catch (err) {
      // Panne globale du lot (réseau, auth, GOAWAY) : tout est retryable,
      // aucun token n'est mort. Surtout ne rien purger ici.
      out.push(...lot.map((t) => ({
        deviceId: t.deviceId,
        ok: false,
        code: err.code || 'transport_error',
        action: 'retry',
      })));
      continue;
    }

    batch.responses.forEach((r, k) => {
      const t = lot[k];
      if (r.success) {
        out.push({ deviceId: t.deviceId, ok: true, messageId: r.messageId, action: 'none' });
        return;
      }
      const code = r.error?.code || 'unknown';
      // Par défaut on retente plutôt que de purger : purger à tort perd
      // définitivement un destinataire, retenter à tort ne coûte qu'un appel.
      const action = DEAD.has(code) ? 'drop_token' : RETRY.has(code) ? 'retry' : 'retry';
      out.push({ deviceId: t.deviceId, ok: false, code, action });
    });
  }

  return out;
}

module.exports = { send, DEAD, RETRY, CHUNK };
