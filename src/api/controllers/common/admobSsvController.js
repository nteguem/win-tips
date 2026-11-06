// src/api/controllers/common/admobSsvController.js
//
// Handler du callback "Server-Side Verification" (SSV) des pubs récompensées
// AdMob. AdMob appelle cette route en GET après chaque pub validée.
//
// Politique de reponse :
//  - HTTP 200 apres sauvegarde durable du callback (fichier et repertoire fsync).
//    La validation Google puis le credit sont effectues par le worker autonome.
//    Une signature invalide, un nonce inconnu ou un doublon ne donne aucun credit.
//  - HTTP 503 si le stockage durable est indisponible ou sa capacite atteinte.
//    Les callbacks deja recus survivent aux pannes Mongo/Google et aux redemarrages.
//    Une panne avant reception durable reste soumise aux retries limites d'AdMob.
//
// URL à renseigner dans la console AdMob :
//   https://api.wintips-expert.com/api/ads/admob/ssv

const admobSsvInbox = require('../../services/common/admobSsvInboxService');
const accessGateService = require('../../services/common/accessGateService');
const logger = require('../../../utils/logger');

exports.handleRewardedSsv = async (req, res) => {
  const log = req.log || logger;
  try {
    const qIdx = req.originalUrl.indexOf('?');
    const rawQuery = qIdx >= 0 ? req.originalUrl.slice(qIdx + 1) : '';
    // HTTP 200 means durably received, never client-authorized. Google signature
    // and business nonce/user matching are checked by the autonomous worker.
    await admobSsvInbox.receive(rawQuery);
    return res.status(200).send('ok');
  } catch (err) {
    // Never acknowledge a callback that could not reach durable storage.
    log.error('[ADMOB SSV] Durable receipt unavailable', { code: err.code || 'inbox_storage_error' });
    return res.status(503).send('retry');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DEV ONLY — simule un callback SSV. AdMob ne déclenche PAS la vraie SSV pour
// les pubs de test / les test devices ; impossible de tester le déblocage de
// bout en bout sans ça. Route montée uniquement si `ENABLE_DEV_REWARDS=true`
// (cf. routes/index.js) → 404 sinon.
// Body JSON : { nonce: string, userId?: string, transactionId?: string }
exports.simulateReward = async (req, res) => {
  const log = req.log || logger;
  try {
    const nonce = req.body && req.body.nonce ? String(req.body.nonce) : null;
    if (!nonce) {
      return res.status(400).json({ success: false, message: 'Champ "nonce" requis.' });
    }
    const r = await accessGateService.recordVerifiedReward({
      nonce,
      userId: (req.body && req.body.userId) || null,
      transactionId: (req.body && req.body.transactionId) ||
        `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      adUnitId: 'dev-simulate',
      adNetwork: 'dev',
      rewardAmount: '1',
      rewardItem: 'Reward',
      timestampMs: String(Date.now())
    });
    log.info('[DEV SSV] Récompense simulée', { nonce, result: r });
    return res.status(200).json({ success: true, data: r });
  } catch (err) {
    log.error('[DEV SSV] Erreur', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: err.message });
  }
};
