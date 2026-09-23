// src/api/services/push/firebaseApps.js
//
// Cache des instances firebase-admin, UNE PAR PROJET Firebase (pas par app).
// bigwin-bd7b5 couvre 5 apps, win-tips-72c2d en couvre 2 : instancier par app
// ouvrirait 7 pools HTTP/2 pour 2 projets.
//
// firebase-admin v14 a SUPPRIMÉ l'API namespacée : `admin.credential.cert()` et
// `admin.messaging()` n'existent plus. Seule l'API modulaire subsiste — l'extrait
// affiché par la console Firebase est périmé.

const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const cache = new Map();

/**
 * @param {Object} appDoc document App (mongoose) portant firebase{}
 * @returns {import('firebase-admin/messaging').Messaging}
 */
function getMessagingFor(appDoc) {
  const cfg = typeof appDoc.getFirebaseConfig === 'function'
    ? appDoc.getFirebaseConfig()
    : appDoc.firebase;

  if (!cfg || !cfg.enabled) {
    throw new Error(`[push] Firebase désactivé pour "${appDoc.appId}"`);
  }
  if (!cfg.serviceAccountKeyPath) {
    throw new Error(`[push] firebase.serviceAccountKeyPath manquant pour "${appDoc.appId}"`);
  }

  // Les documents App portent le chemin SERVEUR de la cle. Pour lancer un envoi
  // depuis un poste de dev (recette avant publication), FIREBASE_KEY_DIR permet
  // de rebaser ce chemin sans toucher a la base, donc sans risquer de laisser
  // un chemin local en production.
  if (process.env.FIREBASE_KEY_DIR) {
    const path = require('path');
    cfg.serviceAccountKeyPath = path.join(
      process.env.FIREBASE_KEY_DIR,
      path.basename(cfg.serviceAccountKeyPath)
    );
  }

  const key = cfg.projectId || cfg.serviceAccountKeyPath;
  if (cache.has(key)) return cache.get(key);

  if (!fs.existsSync(cfg.serviceAccountKeyPath)) {
    throw new Error(`[push] clé de service introuvable : ${cfg.serviceAccountKeyPath}`);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(cfg.serviceAccountKeyPath, 'utf8'));

  if (cfg.projectId && serviceAccount.project_id !== cfg.projectId) {
    throw new Error(
      `[push] incohérence pour "${appDoc.appId}" : firebase.projectId="${cfg.projectId}" ` +
      `mais la clé appartient à "${serviceAccount.project_id}". ` +
      `Envoyer avec la mauvaise clé produit SENDER_ID_MISMATCH sur 100 % des tokens.`
    );
  }

  const name = `push-${key}`;
  const app = getApps().find((a) => a.name === name)
    || initializeApp({ credential: cert(serviceAccount) }, name);

  const messaging = getMessaging(app);
  cache.set(key, messaging);
  return messaging;
}

/** Pour les tests et le rechargement de config à chaud. */
function clearCache() {
  cache.clear();
}

module.exports = { getMessagingFor, clearCache };
