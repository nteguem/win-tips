// src/api/services/push/appContext.js
//
// Ce backend est MONO-TENANT : il n'y a pas de collection `apps`, et le même
// code est déployé deux fois, sur deux bases distinctes — wintips et
// predictfoot. Les deux déploiements partagent le dépôt nteguem/win-tips.
//
// Le socle push a été écrit pour bigwin, qui est multi-tenant et lit sa
// configuration dans un document App. Plutôt que de forker le socle, on
// fabrique ici un document App synthétique à partir de l'environnement : le
// reste du code (firebaseApps, adapters, pushService) garde exactement la même
// forme des deux côtés, ce qui évite qu'ils divergent à la première correction.
//
// Variables attendues :
//   APP_ID                              identité logique ('wintips' ou 'predictfoot')
//   FIREBASE_PROJECT_ID                 projet Firebase (win-tips-72c2d pour les deux)
//   FIREBASE_SERVICE_ACCOUNT_KEY_PATH   chemin de la clé de service
//   ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY   déjà présentes

/**
 * Identité logique de ce déploiement.
 *
 * Ne sert JAMAIS à filtrer la collection `devices` — elle n'a pas de champ
 * appId, chaque base ne contenant que ses propres devices. Sert uniquement à
 * cloisonner PushDelivery, à choisir la clé Firebase, et à préfixer les logs.
 */
function appId() {
  return process.env.APP_ID || 'wintips';
}

/**
 * Document App synthétique, de la forme attendue par firebaseApps et les
 * adapters. `firebase.enabled` reste false tant que le projet n'est pas
 * renseigné : sans clé, providerRouter n'orientera personne vers FCM.
 */
function appDoc() {
  return {
    appId: appId(),
    firebase: {
      projectId: process.env.FIREBASE_PROJECT_ID || null,
      serviceAccountKeyPath: process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || null,
      enabled: Boolean(
        process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH
      ),
    },
    oneSignal: {
      appId: process.env.ONESIGNAL_APP_ID || null,
      restApiKey: process.env.ONESIGNAL_REST_API_KEY || null,
    },
    getFirebaseConfig() {
      return this.firebase;
    },
    getOneSignalConfig() {
      return { appId: this.oneSignal.appId, restApiKey: this.oneSignal.restApiKey };
    },
  };
}

/** OneSignal est-il encore utilisable ? Bascule le 01/10/2026. */
function oneSignalDisponible() {
  if (process.env.PUSH_ONESIGNAL_AVAILABLE === 'false') return false;
  return Boolean(process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY);
}

module.exports = { appId, appDoc, oneSignalDisponible };
