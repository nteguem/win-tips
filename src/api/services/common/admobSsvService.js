// src/api/services/common/admobSsvService.js
//
// Vérification des callbacks "Server-Side Verification" (SSV) des pubs
// récompensées AdMob.
//
// AdMob appelle notre endpoint en GET avec, en dernier, `signature` et
// `key_id`. Le contenu signé = TOUS les paramètres AVANT `&signature=`, sans
// réordonner ni ré-encoder. Signature ECDSA / SHA-256 ; clés publiques fournies
// par le serveur de clés AdMob, rotation possible (cache 1h, max 24h).
//
// Réf : https://developers.google.com/admob/android/ssv

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../../utils/logger');

const VERIFIER_KEYS_URL =
  process.env.ADMOB_SSV_KEYS_URL ||
  'https://www.gstatic.com/admob/reward/verifier-keys.json';

const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = { keysById: new Map(), fetchedAt: 0, fetching: null };

async function fetchKeys() {
  const res = await axios.get(VERIFIER_KEYS_URL, { timeout: 10000 });
  const keys = res && res.data && Array.isArray(res.data.keys) ? res.data.keys : [];
  const keysById = new Map();
  for (const k of keys) {
    if (k && k.keyId != null && k.pem) keysById.set(String(k.keyId), k.pem);
  }
  if (keysById.size === 0) {
    throw new Error('AdMob verifier keys: réponse vide ou inattendue');
  }
  cache = { keysById, fetchedAt: Date.now(), fetching: null };
  return keysById;
}

async function getKeysMap({ force = false } = {}) {
  const stale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (!force && !stale && cache.keysById.size > 0) return cache.keysById;
  if (cache.fetching) return cache.fetching;
  cache.fetching = fetchKeys().catch((err) => {
    cache.fetching = null;
    logger.error('[ADMOB SSV] Échec récupération des clés de vérification', { error: err.message });
    throw err;
  });
  return cache.fetching;
}

async function getPublicKey(keyId) {
  let map;
  try {
    map = await getKeysMap();
  } catch (_) {
    return null;
  }
  if (map.has(String(keyId))) return map.get(String(keyId));
  try {
    map = await getKeysMap({ force: true });
  } catch (_) {
    return null;
  }
  return map.get(String(keyId)) || null;
}

/**
 * Vérifie un callback SSV AdMob à partir de la query string BRUTE.
 *
 * @param {string} rawQuery la query string telle que reçue, sans le `?`
 *   (ex. `req.originalUrl.split('?')[1]`). Ne PAS la réordonner ni ré-encoder.
 */
async function verifyCallback(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return { valid: false, reason: 'empty_query' };
  }

  const sigMarker = '&signature=';
  const idx = rawQuery.indexOf(sigMarker);
  if (idx === -1) return { valid: false, reason: 'no_signature' };

  const signedContent = rawQuery.substring(0, idx);
  const tail = rawQuery.substring(idx + 1);

  // ⚠️ NE PAS extraire `signature` via URLSearchParams : il transforme `+` en
  // espace, corruption d'une signature base64 standard. Extraction brute.
  const sigM = /(?:^|&)signature=([^&]*)/.exec(tail);
  const keyM = /(?:^|&)key_id=([^&]*)/.exec(tail);
  const signatureRaw = sigM ? sigM[1] : null;
  const keyId = keyM ? keyM[1] : null;
  if (!signatureRaw || !keyId) return { valid: false, reason: 'malformed_tail' };

  let signature;
  try {
    let b64 = signatureRaw;
    if (/%[0-9A-Fa-f]{2}/.test(b64)) b64 = decodeURIComponent(b64);
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    signature = Buffer.from(b64, 'base64');
    if (!signature || signature.length === 0) throw new Error('empty');
  } catch (_) {
    return { valid: false, reason: 'bad_signature_encoding' };
  }

  const pem = await getPublicKey(keyId);
  if (!pem) return { valid: false, reason: 'unknown_key_id' };

  // ECDSA-SHA256. AdMob signe normalement la query telle qu'elle apparaît
  // (percent-escapée) avec signature DER. Robustesse : on essaie aussi la query
  // DÉCODÉE + signature IEEE-P1363 (r||s brut).
  let decodedContent = null;
  try { decodedContent = decodeURIComponent(signedContent); } catch (_) {}
  const contentVariants = [['asis', signedContent]];
  if (decodedContent && decodedContent !== signedContent) contentVariants.push(['decoded', decodedContent]);

  let matched = null;
  try {
    for (const [label, content] of contentVariants) {
      const data = Buffer.from(content, 'utf8');
      if (crypto.verify('sha256', data, pem, signature)) { matched = `${label}/der`; break; }
      try {
        if (crypto.verify('sha256', data, { key: pem, dsaEncoding: 'ieee-p1363' }, signature)) {
          matched = `${label}/p1363`;
          break;
        }
      } catch (_) { /* pas brut → continue */ }
    }
  } catch (err) {
    logger.warn('[ADMOB SSV] Erreur lors de la vérification de signature', { error: err.message, keyId });
    return { valid: false, reason: 'verify_error' };
  }
  if (matched && matched !== 'asis/der') {
    logger.info('[ADMOB SSV] Signature vérifiée via variante', { matched, keyId });
  }
  if (!matched) {
    const queryLooksDecodedByProxy =
      /custom_data=\{/.test(signedContent) || /"resourceType":/.test(signedContent);
    let paramOrder = null;
    try { paramOrder = [...new URLSearchParams(signedContent).keys()].join(','); } catch (_) {}
    logger.warn('[ADMOB SSV] Signature invalide', {
      keyId,
      signatureBytes: signature.length,
      signatureRaw,
      queryLooksDecodedByProxy,
      signedContentLength: signedContent.length,
      paramOrder,
      signedContent
    });
    return { valid: false, reason: 'bad_signature' };
  }

  const p = new URLSearchParams(signedContent);
  return {
    valid: true,
    params: {
      adNetwork: p.get('ad_network'),
      adUnit: p.get('ad_unit'),
      customData: p.get('custom_data'),
      rewardAmount: p.get('reward_amount'),
      rewardItem: p.get('reward_item'),
      timestamp: p.get('timestamp'),
      transactionId: p.get('transaction_id'),
      userId: p.get('user_id')
    }
  };
}

module.exports = { verifyCallback };
