// src/api/controllers/common/admobSsvController.js
//
// Handler du callback "Server-Side Verification" (SSV) des pubs récompensées
// AdMob. AdMob appelle cette route en GET après chaque pub validée.
//
// Politique de réponse :
//  - signature invalide / nonce inconnu / récompense déjà comptée → HTTP 200
//    (rien à faire ; inutile qu'AdMob retente)
//  - vraie erreur serveur (DB indisponible, etc.) → HTTP 500 (AdMob retentera,
//    jusqu'à 5 fois à 1 s d'intervalle)
//
// URL à renseigner dans la console AdMob :
//   https://api.wintips-expert.com/api/ads/admob/ssv

const admobSsvService = require('../../services/common/admobSsvService');
const accessGateService = require('../../services/common/accessGateService');
const logger = require('../../../utils/logger');

function parseCustomData(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { /* peut être doublement encodé */ }
  try { return JSON.parse(decodeURIComponent(raw)); } catch (_) { return null; }
}

exports.handleRewardedSsv = async (req, res) => {
  const log = req.log || logger;
  try {
    const qIdx = req.originalUrl.indexOf('?');
    const rawQuery = qIdx >= 0 ? req.originalUrl.slice(qIdx + 1) : '';

    const result = await admobSsvService.verifyCallback(rawQuery);
    if (!result.valid) {
      log.warn('[ADMOB SSV] Callback rejeté', { reason: result.reason });
      return res.status(200).send('ok');
    }

    const {
      customData, userId, transactionId, adUnit, adNetwork, rewardAmount, rewardItem, timestamp
    } = result.params;

    const custom = parseCustomData(customData);
    const nonce = custom && custom.nonce ? String(custom.nonce) : null;
    if (!nonce) {
      log.warn('[ADMOB SSV] custom_data sans nonce exploitable', { hasCustomData: !!customData });
      return res.status(200).send('ok');
    }

    const r = await accessGateService.recordVerifiedReward({
      nonce,
      userId: userId || (custom && custom.userId) || null,
      transactionId,
      adUnitId: adUnit,
      adNetwork,
      rewardAmount,
      rewardItem,
      timestampMs: timestamp
    });

    if (!r.found) {
      log.warn('[ADMOB SSV] Nonce inconnu', { transactionId });
    } else if (r.alreadyProcessed) {
      log.info('[ADMOB SSV] Récompense déjà comptée (retry AdMob)', { transactionId });
    } else if (r.unlocked) {
      log.info('[ADMOB SSV] Récompense vérifiée → ressource débloquée', { transactionId });
    } else {
      log.info('[ADMOB SSV] Récompense vérifiée → progression incrémentée', { transactionId });
    }
    return res.status(200).send('ok');
  } catch (err) {
    log.error('[ADMOB SSV] Erreur de traitement', { error: err.message, stack: err.stack });
    return res.status(500).send('error');
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
