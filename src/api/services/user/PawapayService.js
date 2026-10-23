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
  // 'ORANGE_CMR': 'ORANGE_MONEY_CMR',
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
function getConfig() {
  const env = (process.env.PAWAPAY_ENVIRONMENT === 'production') ? 'production' : 'sandbox';
  const apiUrl = env === 'production'
    ? (process.env.PAWAPAY_PROD_API_URL    || 'https://api.pawapay.io')
    : (process.env.PAWAPAY_SANDBOX_API_URL || 'https://api.sandbox.pawapay.io');
  const token = env === 'production'
    ? process.env.PAWAPAY_PROD_TOKEN
    : process.env.PAWAPAY_SANDBOX_TOKEN;
  if (!token) {
    throw new PawapayError(`Token pawaPay ${env} manquant (configurez PAWAPAY_${env === 'production' ? 'PROD' : 'SANDBOX'}_TOKEN)`, 500);
  }
  return {
    apiUrl,
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
//  SANS le `+` ni le `0` initial, SANS espaces ni separateurs.
// ---------------------------------------------
function normalizePhone(phone, countryCode) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';

  // Cas 1 : le numero contient deja un prefixe ITU connu → on le garde tel quel.
  for (const prefix of Object.keys(PHONE_PREFIX_TO_COUNTRY)) {
    if (digits.startsWith(prefix)) return digits;
  }

  // Cas 2 : le numero commence par '0' (format local national) → on strip
  // le 0 et on prefixe avec le code pays.
  if (digits.startsWith('0')) digits = digits.slice(1);

  const cc = String(countryCode || '').toUpperCase();
  const prefix = COUNTRY_TO_PHONE_PREFIX[cc];
  if (prefix) return `${prefix}${digits}`;

  return digits;
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
async function initiatePayment(user, packageId, phoneNumber, operator, requestedCountry, requestedProvider) {
  let transaction;
  let payload;
  try {
    // 1. Config (resout sandbox/prod)
    const config = getConfig();

    // 2. Resolution pays : explicite > deduit du phoneNumber
    const country = (requestedCountry && String(requestedCountry).toUpperCase())
      || detectCountryFromPhone(phoneNumber);
    if (!country) {
      throw new AppError(
        'Impossible de detecter le pays depuis le numero. Precisez `country` (ISO-2).',
        400, ErrorCodes.VALIDATION_ERROR
      );
    }

    // 3. Resolution provider : explicite > construit depuis operator+country
    let provider;
    if (requestedProvider) {
      provider = String(requestedProvider).toUpperCase();
    } else {
      if (!operator) {
        throw new AppError('operator ou provider est requis', 400, ErrorCodes.VALIDATION_ERROR);
      }
      provider = buildProviderCode(country, operator);
    }

    // 4. Package + montant + devise
    const packageDoc = await Package.findById(packageId);
    if (!packageDoc) throw new AppError('Package non trouve', 404, ErrorCodes.NOT_FOUND);

    const currency = currencyForCountry(country);
    const amount = packageDoc.pricing?.get
      ? packageDoc.pricing.get(currency)
      : packageDoc.pricing?.[currency];
    if (!amount || amount <= 0) {
      throw new AppError(`Prix ${currency} non disponible pour ce package`, 400, ErrorCodes.VALIDATION_ERROR);
    }

    // 5. Numero normalise (MSISDN brut)
    const recipientPhone = normalizePhone(phoneNumber, country);
    if (!recipientPhone) {
      throw new AppError('phoneNumber invalide', 400, ErrorCodes.VALIDATION_ERROR);
    }

    // 6. Infos client (denormalisees pour reporting)
    const firstName = user.firstName || user.pseudo || 'Utilisateur';
    const lastName  = user.lastName || firstName;
    const email     = user.email || `user_${user._id}@wintips-expert.com`;
    const designation = `${packageDoc.name?.fr || packageDoc.name} - ${packageDoc.duration}j`;
    // pawaPay rejette tout caractere non-alphanumerique dans customerMessage.
    // On strip les diacritiques (NFD → ASCII) puis on ne garde que [A-Za-z0-9 ],
    // et on cap a 22 chars.
    const customerMessage = String(designation)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 22);

    // 7. depositId = UUID v4 (notre cote ET cote pawaPay — meme valeur)
    const depositId = uuidv4();
    const clientReferenceId = `WT-${Date.now()}-${depositId.substring(0, 8)}`;

    // 8. Sauvegarder en base avant l'appel API (idempotency)
    transaction = new PawapayTransaction({
      depositId,
      clientReferenceId,
      user: user._id,
      package: packageId,
      countryCode: country,
      amount,
      currency,
      status: 'PENDING',
      provider,
      phoneNumber: recipientPhone,
      customerEmail: email,
      customerFirstName: firstName,
      customerLastName:  lastName,
      customerMessage,
      designation,
      environment: config.environment
    });
    await transaction.save();
    console.log(`[${SERVICE}] initiate: transaction saved (pre-API) depositId=${depositId} provider=${provider} ${amount} ${currency} env=${config.environment}`);

    // 9. Appel API pawaPay — POST /v2/deposits
    payload = {
      depositId,
      payer: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: recipientPhone,
          provider
        }
      },
      amount: String(amount),       // pawaPay attend une string
      currency,
      clientReferenceId,
      customerMessage
    };

    const response = await axios.post(`${config.apiUrl}/v2/deposits`, payload, {
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      timeout: 30000
    });

    const data = response.data || {};
    console.log(`[${SERVICE}] initiate: API response depositId=${depositId} status=${data.status}`);

    // 10. Mapper le statut initial
    transaction.providerData = data;
    const mapped = mapApiStatus(data.status);
    transaction.status = mapped || 'INITIATED';
    if (data.failureReason) {
      transaction.failureCode    = data.failureReason.failureCode;
      transaction.failureMessage = data.failureReason.failureMessage;
    }
    await transaction.save();

    await transaction.populate(['package', 'user']);
    console.log(`[${SERVICE}] initiate: OK depositId=${depositId} finalStatus=${transaction.status}`);

    return { transaction };
  } catch (error) {
    const isAxiosError = !!error.response;
    console.error(`[${SERVICE}] initiate: failed depositId=${transaction?.depositId || null} message=${error.message} httpStatus=${error.response?.status || null}`, error.response?.data || '');
    if (transaction?._id) {
      await PawapayTransaction.findByIdAndDelete(transaction._id).catch(() => {});
    }
    if (error instanceof PawapayError || error instanceof AppError) throw error;
    if (isAxiosError) {
      throw new PawapayError(
        error.response.data?.failureReason?.failureMessage
          || error.response.data?.message
          || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

// ---------------------------------------------
//  VERIFIER LE STATUT D'UNE TRANSACTION
//  GET /v2/deposits/{depositId} — Bearer auth
//  Utilise par le controller checkStatus, le webhook (anti-spoofing) ET le cron.
// ---------------------------------------------
async function checkTransactionStatus(depositId) {
  try {
    // 1. Trouver la transaction
    const transaction = await PawapayTransaction.findOne({ depositId })
      .populate(['package', 'user']);
    if (!transaction) throw new AppError('Transaction non trouvee', 404, ErrorCodes.NOT_FOUND);

    // 2. Config
    const config = getConfig();

    // 3. GET /v2/deposits/{depositId} — Bearer
    const response = await axios.get(`${config.apiUrl}/v2/deposits/${depositId}`, {
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept':        'application/json'
      },
      timeout: 30000
    });

    // pawaPay v2 GET /deposits/{id} renvoie un wrapper :
    //   { data: { depositId, status: COMPLETED|FAILED|..., amount, ..., failureReason? },
    //     status: FOUND|NOT_FOUND }
    // → le vrai status metier est dans `data.data.status`, pas `data.status`.
    const raw = response.data || {};
    const inner = raw.data || raw;
    console.log(`[${SERVICE}] checkStatus: depositId=${depositId} apiStatus=${raw.status} innerStatus=${inner.status}`);

    transaction.providerData = raw;

    const mapped = mapApiStatus(inner.status);
    if (mapped) transaction.status = mapped;

    if (inner.providerTransactionId) {
      transaction.providerData = { ...raw, _providerTransactionId: inner.providerTransactionId };
    }

    if (inner.failureReason) {
      transaction.failureCode    = inner.failureReason.failureCode;
      transaction.failureMessage = inner.failureReason.failureMessage;
    }

    await transaction.save();
    return transaction;
  } catch (error) {
    console.error(`[${SERVICE}] checkStatus: failed depositId=${depositId} message=${error.message} httpStatus=${error.response?.status || null}`, error.response?.data || '');
    if (error instanceof PawapayError || error instanceof AppError) throw error;
    if (error.response) {
      throw new PawapayError(
        error.response.data?.failureReason?.failureMessage
          || error.response.data?.message
          || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
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
    const firstProv = c.providers?.[0];
    const currency = firstProv?.currencies?.[0]?.currency || currencyForCountry(iso2);
    out[iso2] = {
      country:     iso2,
      iso3,
      displayName: c.displayName,
      prefix:      c.prefix,
      flag:        c.flag,
      currency,
      providers: (c.providers || []).map(p => {
        const cur = p.currencies?.[0];
        const dep = cur?.operationTypes?.DEPOSIT;
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
          minAmount:       dep?.minAmount || null,
          maxAmount:       dep?.maxAmount || null,
          status:          dep?.status || null,                 // OPERATIONAL / DELAYED / CLOSED
          authType:        dep?.authType || null,
          pinPrompt:       dep?.pinPrompt || null,              // AUTOMATIC / MANUAL
          pinPromptRevivable: dep?.pinPromptRevivable ?? null,
          pinInstructions
        };
      })
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
  PawapayError
};
