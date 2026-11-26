// services/user/PawapayService.js
//
// Integration pawaPay v2 — collecte mobile money (deposits) multi-pays.
//   - POST /v2/deposits           → init paiement (Bearer JWT)
//   - GET  /v2/deposits/{id}      → check status (Bearer JWT)
//   - GET  /v2/active-conf        → liste providers par pays (Bearer JWT)
//   - Webhook : configure dans le dashboard pawaPay, signature RFC 9421
//
// Version MONO-TENANT (win_tips) : la config (URLs, tokens, environnement)
// est lue depuis les variables d'environnement (.env), et non par app comme
// dans bigwin. Compte pawaPay partage avec bigwin (memes tokens).
//
// Particularites :
//   - 1 token = ~20 pays africains. Le pays est encode dans le `provider`
//     (ex: MTN_MOMO_CMR).
//   - Sandbox et prod ont des URLs distinctes + tokens distincts.
//   - L'ID transaction est un UUID v4 que NOUS generons et que pawaPay
//     reutilise tel quel (depositId). Pas de mapping interne/externe.

const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const PawapayTransaction = require('../../models/user/PawapayTransaction');
const Package = require('../../models/common/Package');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

const SERVICE = 'pawapay';
const safety = require('./paymentTransactionSafety');

// ---------------------------------------------
//  Erreur personnalisee
// ---------------------------------------------
class PawapayError extends Error {
  constructor(message, statusCode, responseData) {
    super(message);
    this.name = 'PawapayError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

// ---------------------------------------------
//  Mapping ISO-2 → ISO-3 (pawaPay attend ISO-3 dans le code provider)
// ---------------------------------------------
const ISO2_TO_ISO3 = {
  CM: 'CMR', CI: 'CIV', SN: 'SEN', BJ: 'BEN', BF: 'BFA',
  CD: 'COD', GA: 'GAB', CG: 'COG', GH: 'GHA', KE: 'KEN',
  RW: 'RWA', UG: 'UGA', TZ: 'TZA', ZM: 'ZMB', NG: 'NGA',
  MW: 'MWI', LS: 'LSO', MZ: 'MOZ', SL: 'SLE'
};

function iso3ToIso2(iso3) {
  for (const [iso2, code3] of Object.entries(ISO2_TO_ISO3)) {
    if (code3 === iso3) return iso2;
  }
  return null;
}

// ---------------------------------------------
//  Mapping pays → devise par defaut
// ---------------------------------------------
function currencyForCountry(countryCode) {
  switch ((countryCode || '').toUpperCase()) {
    case 'CM': case 'CG': case 'GA':                  return 'XAF';
    case 'CI': case 'SN': case 'BJ': case 'BF':       return 'XOF';
    case 'CD':                                         return 'CDF';
    case 'GH':                                         return 'GHS';
    case 'KE':                                         return 'KES';
    case 'UG':                                         return 'UGX';
    case 'TZ':                                         return 'TZS';
    case 'ZM':                                         return 'ZMW';
    case 'NG':                                         return 'NGN';
    case 'RW':                                         return 'RWF';
    case 'MW':                                         return 'MWK';
    case 'LS':                                         return 'LSL';
    case 'MZ':                                         return 'MZN';
    case 'SL':                                         return 'SLE';
    default:                                           return 'XAF';
  }
}

// ---------------------------------------------
//  Detection pays depuis le numero (prefixe ITU)
// ---------------------------------------------
const PHONE_PREFIX_TO_COUNTRY = {
  '237': 'CM', '225': 'CI', '221': 'SN', '229': 'BJ', '226': 'BF',
  '243': 'CD', '241': 'GA', '242': 'CG', '233': 'GH', '254': 'KE',
  '250': 'RW', '256': 'UG', '255': 'TZ', '260': 'ZM', '234': 'NG',
  '265': 'MW', '266': 'LS', '258': 'MZ', '232': 'SL'
};

function detectCountryFromPhone(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  for (const [prefix, code] of Object.entries(PHONE_PREFIX_TO_COUNTRY)) {
    if (cleaned.startsWith(prefix)) return code;
  }
  return null;
}

// ---------------------------------------------
//  Construction du provider code pawaPay
//  Format : {OPERATOR}_{ISO3} ex: MTN_MOMO_CMR, ORANGE_CIV
//    mtn        → MTN_MOMO
//    om/orange  → ORANGE
//    airtel     → AIRTEL_OAPI
//    mpesa      → MPESA (KE/TZ)
//    vodacom    → VODACOM_MPESA (TZ/CD)
//    moov       → MOOV (CI/BJ/TG)
//    tigo       → TIGO
// ---------------------------------------------
const OPERATOR_NORMALIZED = {
  'mtn':     'MTN_MOMO',
  'om':      'ORANGE',
  'orange':  'ORANGE',
  'airtel':  'AIRTEL_OAPI',
  'mpesa':   'MPESA',
  'vodacom': 'VODACOM_MPESA',
  'moov':    'MOOV',
  'tigo':    'TIGO'
};

// Cas particuliers ou pawaPay a un code provider non standard. Ces overrides
// remplacent le code generique calcule depuis OPERATOR_NORMALIZED + ISO3.
// A enrichir au fur et a mesure des decouvertes via /v2/active-conf.
const PROVIDER_OVERRIDES = {
  AIRTEL_OAPI_GAB: 'AIRTEL_GAB',
  AIRTEL_OAPI_COD: 'AIRTEL_COD',
  AIRTEL_OAPI_COG: 'AIRTEL_COG',
};

function buildProviderCode(countryCode, operator) {
  const iso3 = ISO2_TO_ISO3[String(countryCode || '').toUpperCase()];
  if (!iso3) {
    throw new PawapayError(`Pays non supporte par pawaPay: ${countryCode}`, 400);
  }
  const opKey = String(operator || '').toLowerCase();
  const opCode = OPERATOR_NORMALIZED[opKey];
  if (!opCode) {
    throw new PawapayError(`Operateur non reconnu: ${operator}. Valeurs supportees: ${Object.keys(OPERATOR_NORMALIZED).join(', ')}`, 400);
  }
  const code = `${opCode}_${iso3}`;
  return PROVIDER_OVERRIDES[code] || code;
}

// ---------------------------------------------
//  Lire la config depuis les variables d'environnement.
//  Resout sandbox OU prod selon PAWAPAY_ENVIRONMENT.
// ---------------------------------------------
function getConfig(environment) {
  const env = ((environment || process.env.PAWAPAY_ENVIRONMENT) === 'production') ? 'production' : 'sandbox';
  const apiUrl = env === 'production'
    ? (process.env.PAWAPAY_PROD_API_URL    || 'https://api.pawapay.io')
    : (process.env.PAWAPAY_SANDBOX_API_URL || 'https://api.sandbox.pawapay.io');
  const token = env === 'production'
    ? process.env.PAWAPAY_PROD_TOKEN
    : process.env.PAWAPAY_SANDBOX_TOKEN;
  if (!token) {
    throw new PawapayError('Le paiement pawaPay est momentanément indisponible', 503);
  }
  try {
    if (new URL(apiUrl).protocol !== 'https:') throw new Error('HTTPS required');
  } catch (_) { throw new PawapayError('Le paiement pawaPay est momentanément indisponible', 503); }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    environment: env,
    token,
    webhookPublicKey: process.env.PAWAPAY_WEBHOOK_PUBLIC_KEY || null
  };
}

// ---------------------------------------------
//  Mapping ISO-2 → prefixe ITU (inverse de PHONE_PREFIX_TO_COUNTRY)
// ---------------------------------------------
const COUNTRY_TO_PHONE_PREFIX = {
  CM: '237', CI: '225', SN: '221', BJ: '229', BF: '226',
  CD: '243', GA: '241', CG: '242', GH: '233', KE: '254',
  RW: '250', UG: '256', TZ: '255', ZM: '260', NG: '234',
  MW: '265', LS: '266', MZ: '258', SL: '232'
};

// ---------------------------------------------
//  Normaliser le numero (MSISDN brut sans + ni espaces)
//  pawaPay attend uniquement des digits avec code pays international,
//  Sans `+`, espaces ou séparateurs ; conserver les zéros nationaux
//  significatifs des pays concernés (notamment CI et CG).
// ---------------------------------------------
function normalizePhone(phone, countryCode) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const country = String(countryCode || '').toUpperCase();
  const prefix = COUNTRY_TO_PHONE_PREFIX[country];
  if (!digits || !prefix) return '';
  let local = digits.startsWith(prefix) ? digits.slice(prefix.length) : digits;
  // Côte d'Ivoire and Congo keep their significant local zero. Benin's
  // national 01 prefix is not part of pawaPay's provider wallet identifier.
  if (country === 'BJ' && local.length === 10 && local.startsWith('01')) local = local.slice(2);
  if (country === 'GA' && local.length === 9 && local.startsWith('0')) local = local.slice(1);
  if (!['CI', 'CG', 'BJ', 'GA'].includes(country) && local.startsWith('0')) local = local.slice(1);
  const lengths = { CM: [9], CI: [10], CG: [9], GA: [8], BJ: [8], SN: [9], CD: [9], BF: [8],
    GH: [9], KE: [9], RW: [9], UG: [9], TZ: [9], ZM: [9], NG: [10], MW: [9], LS: [8], MZ: [9], SL: [8] };
  if (!lengths[country]?.includes(local.length)) return '';
  return prefix + local;
}

function reconcileReceipt(transaction, receipt) {
  const account = receipt?.payer?.accountDetails || {};
  const phone = account.phoneNumber || account.phoneNUmber; // Official v2 example spelling.
  return receipt?.depositId === transaction.depositId &&
    Number.isFinite(Number(receipt.amount)) && Number(receipt.amount) === Number(transaction.amount) &&
    receipt.currency === transaction.currency &&
    account.provider === transaction.provider && phone === transaction.phoneNumber &&
    receipt.clientReferenceId === transaction.clientReferenceId;
}

// ---------------------------------------------
//  Mapping statut pawaPay → statut interne
//    Init synchrone : ACCEPTED, REJECTED, DUPLICATE_IGNORED
//    Final (via webhook / check status) : COMPLETED, FAILED
// ---------------------------------------------
function mapApiStatus(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).toUpperCase();
  if (s === 'COMPLETED' || s === 'SUCCESS' || s === 'SUCCESSFUL')   return 'SUCCESS';
  if (s === 'FAILED' || s === 'REJECTED')                            return 'FAILED';
  if (s === 'EXPIRED')                                                return 'EXPIRED';
  if (s === 'ACCEPTED' || s === 'PROCESSING' || s === 'SUBMITTED')   return 'INITIATED';
  if (s === 'IN_RECONCILIATION' || s === 'ENQUEUED')                  return 'INITIATED';
  if (s === 'DUPLICATE_IGNORED')                                      return 'INITIATED';
  if (s === 'PENDING')                                                return 'PENDING';
  return null;
}

// ---------------------------------------------
//  Generer l'URL callback (webhook) — informatif (le webhook est configure
//  dans le dashboard pawaPay, pas envoye dans le payload).
// ---------------------------------------------
function generateUrls() {
  const base = process.env.APP_BASE_URL;
  return {
    callback_url: `${base}/api/payments/pawapay/webhook`
  };
}

// ---------------------------------------------
//  INITIER UN PAIEMENT (deposit) — POST /v2/deposits (Bearer)
// ---------------------------------------------
async function initiatePayment(user, packageId, phoneNumber, operator, requestedCountry, requestedProvider, requestedReference, preAuthorisationCode) {
  const config = getConfig();
  const clientReference = safety.validateClientReference(requestedReference);
  const country = String(requestedCountry || detectCountryFromPhone(phoneNumber) || '').toUpperCase();
  if (!ISO2_TO_ISO3[country]) throw new AppError('Pays de paiement invalide', 400, ErrorCodes.VALIDATION_ERROR);
  const provider = requestedProvider ? String(requestedProvider).toUpperCase() : buildProviderCode(country, operator);
  if (!provider.endsWith('_' + ISO2_TO_ISO3[country])) throw new AppError('Opérateur incompatible avec le pays', 400, ErrorCodes.VALIDATION_ERROR);
  const recipientPhone = normalizePhone(phoneNumber, country);
  if (!recipientPhone) throw new AppError('Numéro de téléphone invalide pour ce pays', 400, ErrorCodes.VALIDATION_ERROR);
  const depositId = clientReference ? safety.referenceId('pawapay', user._id, clientReference) : uuidv4();
  const existing = await PawapayTransaction.findOne({ depositId });
  if (existing) {
    safety.assertSamePurchase(existing, packageId, { phoneNumber: recipientPhone, provider });
    if (['PREPARED', 'REQUIRES_INPUT'].includes(existing.initiationPhase)) return submitPreparedPayment(existing, getConfig(existing.environment), preAuthorisationCode);
    return { transaction: existing, pending: existing.verificationPending === true };
  }
  const packageDoc = await Package.findById(packageId);
  if (!packageDoc || packageDoc.isActive === false || packageDoc.paymentMode === 'ads') throw new AppError('Package non disponible', 404, ErrorCodes.NOT_FOUND);
  const currency = currencyForCountry(country);
  const amount = Number(packageDoc.pricing?.get ? packageDoc.pricing.get(currency) : packageDoc.pricing?.[currency]);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(`Prix ${currency} non disponible`, 400, ErrorCodes.VALIDATION_ERROR);
  const catalogue = await getProvidersAsync(country);
  const availableProvider = catalogue.country?.providers?.find(item => item.provider === provider);
  if (!availableProvider || availableProvider.currency !== currency || !['OPERATIONAL', 'DELAYED'].includes(availableProvider.status)) {
    throw new AppError('Cet opérateur est momentanément indisponible', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const preauth = String(availableProvider.authType || '').replace(/_/g, '').toUpperCase().includes('PREAUTH');
  if ((preAuthorisationCode != null && (typeof preAuthorisationCode !== 'string' || !/^[A-Za-z0-9]{1,36}$/.test(preAuthorisationCode))) ||
      (preauth && !preAuthorisationCode)) {
    throw new AppError('Saisissez le code de paiement fourni par votre opérateur', 400, ErrorCodes.VALIDATION_ERROR);
  }
  if ((availableProvider.minAmount != null && amount < availableProvider.minAmount) ||
      (availableProvider.maxAmount != null && amount > availableProvider.maxAmount)) {
    throw new AppError('Montant hors des limites de cet opérateur', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const designation = `${packageDoc.name?.fr || packageDoc.name?.en || packageDoc.name || 'Acces'} - ${packageDoc.duration}j`;
  const customerMessage = String(designation).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 22).padEnd(4, ' ');
  let transaction = new PawapayTransaction({
    depositId, clientReference, clientReferenceId: `PF-${depositId.substring(0, 20)}`,
    user: user._id, package: packageId, countryCode: country, amount, currency,
    status: 'PENDING', provider, phoneNumber: recipientPhone,
    customerEmail: user.email || undefined, customerFirstName: user.firstName || user.pseudo || 'Utilisateur',
    customerLastName: user.lastName || user.pseudo || 'Utilisateur', customerMessage, designation,
    environment: config.environment, initiationPhase: 'PREPARED', requiresPreAuth: preauth, paymentSnapshot: safety.snapshot(packageDoc, amount, currency)
  });
  try { await transaction.save(); } catch (error) {
    if (error.code !== 11000 || !clientReference) throw error;
    const winner = await PawapayTransaction.findOne({ depositId });
    if (!winner) throw error;
    safety.assertSamePurchase(winner, packageId, { phoneNumber: recipientPhone, provider });
    if (winner.initiationPhase === 'PREPARED') return submitPreparedPayment(winner, config, preAuthorisationCode);
    return { transaction: winner, pending: true };
  }
  return submitPreparedPayment(transaction, config, preAuthorisationCode);
}

async function submitPreparedPayment(transaction, config, preAuthorisationCode) {
  if (transaction.requiresPreAuth && !preAuthorisationCode) {
    throw new AppError('Saisissez un nouveau code fourni par votre opérateur', 400, ErrorCodes.VALIDATION_ERROR);
  }
  if (preAuthorisationCode != null && (typeof preAuthorisationCode !== 'string' || !/^[A-Za-z0-9]{1,36}$/.test(preAuthorisationCode))) {
    throw new AppError('Code de paiement invalide', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const claimed = await PawapayTransaction.findOneAndUpdate({ _id: transaction._id, initiationPhase: { $in: ['PREPARED', 'REQUIRES_INPUT'] } },
    { $set: { initiationPhase: 'SUBMITTING', initiationClaimedAt: new Date(), retryable: false, requiresInput: false }, $inc: { initiationAttempts: 1 } }, { new: true });
  if (!claimed) return { transaction: await PawapayTransaction.findById(transaction._id), pending: true };
  transaction = claimed;
  const { depositId, phoneNumber: recipientPhone, provider, amount, currency, customerMessage } = transaction;
  const payload = { depositId, payer: { type: 'MMO', accountDetails: { phoneNumber: recipientPhone, provider } },
    amount: String(amount), currency, clientReferenceId: transaction.clientReferenceId, customerMessage };
  // The short-lived operator code is sent only to the PSP, never persisted or
  // logged. Retrying a saved transaction does not request another debit.
  if (preAuthorisationCode) payload.preAuthorisationCode = preAuthorisationCode;
  try {
    const response = await axios.post(`${config.apiUrl}/v2/deposits`, payload, {
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000
    });
    const data = response.data || {};
    // Initiation acknowledges a request only. Settlement requires an independently
    // fetched and reconciled receipt; never activate from an initiation response.
    const rejected = data.status === 'REJECTED' || data.status === 'FAILED';
    const known = ['ACCEPTED', 'DUPLICATE_IGNORED'].includes(data.status);
    transaction = await safety.updateStatus(PawapayTransaction, transaction, rejected ? 'FAILED' : known ? 'INITIATED' : 'PENDING', {
      providerData: data, verificationPending: !rejected && !known, initiationPhase: rejected ? 'REJECTED' : known ? 'SUBMITTED' : 'UNCERTAIN', retryable: false, requiresInput: false,
      failureCode: data.failureReason?.failureCode, failureMessage: data.failureReason?.failureMessage
    }, 'SUCCESS');
    return { transaction, refused: rejected, pending: !rejected && !known };
  } catch (error) {
    // Network timeouts and HTTP errors do not prove the operator rejected a
    // charge. Keep the exact deposit ID for webhook/status/cron recovery.
    transaction = await safety.updateStatus(PawapayTransaction, transaction, 'PENDING', {
      verificationPending: true, initiationPhase: 'UNCERTAIN', lastVerificationError: 'INITIATION_UNCERTAIN', lastCheckedAt: new Date()
    }, 'SUCCESS');
    console.warn('[pawapay] initiation outcome uncertain', { code: error.code || 'PSP_ERROR', httpStatus: error.response?.status });
    return { transaction, pending: true };
  }
}

async function checkTransactionStatus(depositId) {
  const transaction = await PawapayTransaction.findOne({ depositId }).populate(['package', 'user']);
  if (!transaction) throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
  const config = getConfig(transaction.environment);
  const response = await axios.get(`${config.apiUrl}/v2/deposits/${encodeURIComponent(depositId)}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' }, timeout: 15000
  });
  const raw = response.data || {};
  const inner = raw.data || raw;
  const mapped = mapApiStatus(inner.status);
  if (raw.status === 'NOT_FOUND' &&
      ['PREPARED', 'SUBMITTING', 'UNCERTAIN', 'REQUIRES_INPUT'].includes(transaction.initiationPhase) &&
      Date.now() - new Date(transaction.initiationClaimedAt || transaction.createdAt).getTime() > 2 * 60 * 1000) {
    // Verification never starts a payment. A deliberate user retry can reuse
    // this idempotent deposit ID and its immutable purchase details.
    const prepared = await safety.prepareRetry(PawapayTransaction, transaction, {
      initiationPhase: transaction.requiresPreAuth ? 'REQUIRES_INPUT' : 'PREPARED',
      retryable: true, requiresInput: transaction.requiresPreAuth === true, verificationPending: true
    });
    return prepared;
  }
  const patch = { providerData: raw, ...(raw.status === 'FOUND' ? { initiationPhase: 'SUBMITTED', retryable: false, requiresInput: false } : {}), lastCheckedAt: new Date(), verificationPending: raw.status === 'NOT_FOUND', lastVerificationError: null };
  if (inner.failureReason) {
    patch.failureCode = inner.failureReason.failureCode;
    patch.failureMessage = inner.failureReason.failureMessage;
  }
  if (mapped === 'SUCCESS' && !reconcileReceipt(transaction, inner)) {
    await safety.updateStatus(PawapayTransaction, transaction, null, {
      ...patch, reconciliationMismatch: true, verificationPending: true, lastVerificationError: 'RECEIPT_MISMATCH'
    }, 'SUCCESS');
    throw new PawapayError('Le reçu de paiement doit être vérifié', 502);
  }
  patch.reconciliationMismatch = false;
  return safety.updateStatus(PawapayTransaction, transaction, mapped, patch, 'SUCCESS');
}

// ---------------------------------------------
//  VERIFIER LA SIGNATURE WEBHOOK (RFC 9421 HTTP Signatures)
//
//  V1 : on verifie uniquement le Content-Digest (integrite du body). La
//  signature RSA complete sera ajoutee quand on aura la cle publique exacte.
//  En attendant, fallback robuste : on rappelle systematiquement
//  `GET /v2/deposits/{id}` apres reception du webhook (idem CinetPay).
// ---------------------------------------------
function verifyContentDigest(rawBody, contentDigestHeader) {
  if (!contentDigestHeader) return false;
  const match = /sha-256=:([^:]+):/i.exec(contentDigestHeader);
  if (!match) return false;
  const expected = match[1];
  const computed = crypto.createHash('sha256').update(rawBody).digest('base64');
  return expected === computed;
}

// ---------------------------------------------
//  LISTE DES PROVIDERS PAR PAYS (cache 1h)
//  GET /v2/active-conf — Bearer auth
// ---------------------------------------------
let cachedActiveConf = null;
let cachedActiveConfExpiry = 0;
let cachedActiveConfKey = null;
const ACTIVE_CONF_TTL_MS = 60 * 60 * 1000; // 1 heure

function normalizeActiveConf(raw) {
  const out = {};
  for (const c of (raw?.countries || [])) {
    const iso3 = c.country;
    const iso2 = iso3ToIso2(iso3) || iso3;
    const currency = currencyForCountry(iso2);
    out[iso2] = {
      country:     iso2,
      iso3,
      displayName: c.displayName,
      prefix:      c.prefix,
      flag:        c.flag,
      currency,
      providers: (c.providers || []).map(p => {
        const cur = p.currencies?.find(item => item.currency === currency && item.operationTypes?.DEPOSIT);
        const dep = cur?.operationTypes?.DEPOSIT;
        if (!dep || dep.authType === 'REDIRECT_AUTH') return null;
        // pinPrompt = AUTOMATIC (push USSD) OU MANUAL (le client doit composer
        // un code USSD pour recuperer sa transaction en attente).
        let pinInstructions = null;
        if (dep?.pinPromptInstructions?.channels?.length) {
          pinInstructions = {
            channels: dep.pinPromptInstructions.channels.map(ch => ({
              type:         ch.type,
              displayName:  ch.displayName,
              shortCode:    ch.variables?.shortCode || null,
              instructions: ch.instructions
            }))
          };
        }
        return {
          provider:        p.provider,
          displayName:     p.displayName || p.nameDisplayedToCustomer || p.provider,
          logo:            p.logo,
          currency:        cur?.currency || currency,
          minAmount:       dep?.minAmount != null && Number.isFinite(Number(dep.minAmount)) ? Number(dep.minAmount) : null,
          maxAmount:       dep?.maxAmount != null && Number.isFinite(Number(dep.maxAmount)) ? Number(dep.maxAmount) : null,
          status:          dep?.status || null,                 // OPERATIONAL / DELAYED / CLOSED
          authType:        dep?.authType || null,
          pinPrompt:       dep?.pinPrompt || null,              // AUTOMATIC / MANUAL
          pinPromptRevivable: dep?.pinPromptRevivable ?? null,
          pinInstructions
        };
      }).filter(Boolean)
    };
  }
  return out;
}

async function getProvidersAsync(countryFilter = null) {
  const config = getConfig();
  const key = config.environment + ':' + (config.token || '').slice(-12);

  let countries;
  if (cachedActiveConf && cachedActiveConfExpiry > Date.now() && cachedActiveConfKey === key) {
    countries = cachedActiveConf;
  } else {
    const r = await axios.get(`${config.apiUrl}/v2/active-conf?operationType=DEPOSIT`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      timeout: 15000
    });
    countries = normalizeActiveConf(r.data);
    cachedActiveConf = countries;
    cachedActiveConfKey = key;
    cachedActiveConfExpiry = Date.now() + ACTIVE_CONF_TTL_MS;
    console.log(`[${SERVICE}] active-conf: refreshed env=${config.environment} countries=${Object.keys(countries).length}`);
  }

  if (countryFilter) {
    const cc = String(countryFilter).toUpperCase();
    const found = countries[cc] || null;
    return {
      country:            found,
      availableCountries: Object.keys(countries)
    };
  }
  return {
    countries:          Object.values(countries),
    availableCountries: Object.keys(countries)
  };
}

function clearProvidersCache() {
  cachedActiveConf = null;
  cachedActiveConfKey = null;
  cachedActiveConfExpiry = 0;
}

module.exports = {
  getConfig,
  initiatePayment,
  checkTransactionStatus,
  getProvidersAsync,
  clearProvidersCache,
  generateUrls,
  mapApiStatus,
  detectCountryFromPhone,
  buildProviderCode,
  currencyForCountry,
  normalizePhone,
  verifyContentDigest,
  reconcileReceipt,
  normalizeActiveConf,
  PawapayError
};
