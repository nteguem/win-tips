const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const SmobilpayTransaction = require('../../models/user/SmobilpayTransaction');
const Package = require('../../models/common/Package');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

// Configuration
const API_URL = process.env.SMOBILPAY_API_URL;
const API_KEY = process.env.SMOBILPAY_API_KEY;
const API_SECRET = process.env.SMOBILPAY_API_SECRET;

// Classe d'erreur personnalisée
class SmobilpayError extends Error {
  constructor(message, statusCode, responseData) {
    super(message);
    this.name = 'SmobilpayError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

// Mapping des codes pays
const COUNTRY_MAPPING = {
  'CM': { name: 'Cameroun', prefixes: ['CM'] },
  'GA': { name: 'Gabon', prefixes: ['GAB'] },
  'TD': { name: 'Tchad', prefixes: ['TCD'] },
  'CF': { name: 'RCA', prefixes: ['RCA'] },
  'CG': { name: 'Congo', prefixes: ['CG'] }
};

/**
 * Générer l'en-tête d'authentification Smobilpay
 */
function generateAuthHeader(method, url, params = {}, data = null) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Date.now().toString();
  const signatureMethod = "HMAC-SHA1";
  
  const s3pParams = {
    s3pAuth_nonce: nonce,
    s3pAuth_timestamp: timestamp,
    s3pAuth_signature_method: signatureMethod,
    s3pAuth_token: API_KEY
  };
  
  const allParams = {...params, ...(data || {}), ...s3pParams};
  
  const sortedParams = Object.keys(allParams).sort().reduce((r, k) => {
    r[k] = typeof allParams[k] === 'string' ? allParams[k].trim() : allParams[k];
    return r;
  }, {});
  
  const parameterString = Object.keys(sortedParams)
    .map(key => key + '=' + sortedParams[key])
    .join('&');
  
  const baseString = method + "&" + encodeURIComponent(url) + "&" + encodeURIComponent(parameterString);
  
  const signature = crypto.createHmac('sha1', API_SECRET)
    .update(baseString)
    .digest('base64');
  
  const authHeader = "s3pAuth " +
    "s3pAuth_timestamp=\"" + timestamp + "\", " +
    "s3pAuth_signature=\"" + signature + "\", " +
    "s3pAuth_nonce=\"" + nonce + "\", " +
    "s3pAuth_signature_method=\"" + signatureMethod + "\", " +
    "s3pAuth_token=\"" + API_KEY + "\"";
  
  return authHeader;
}

/**
 * Filtrer les services par pays
 */
function filterServicesByCountry(services, countryCode) {
  if (!countryCode) return services;
  
  const mapping = COUNTRY_MAPPING[countryCode.toUpperCase()];
  if (!mapping) return [];
  
  return services.filter(service =>
    mapping.prefixes.some(prefix =>
      service.merchant && service.merchant.startsWith(prefix)
    )
  );
}

/**
 * Nettoyer le nom du merchant selon le pays
 */
function cleanMerchantName(merchantName, countryCode) {
  if (!merchantName || !countryCode) return merchantName;
  
  let cleanedName = merchantName;
  
  switch (countryCode.toUpperCase()) {
    case 'CM':
      // Retirer CM au début et CC à la fin
      if (cleanedName.startsWith('CM')) {
        cleanedName = cleanedName.substring(2);
      }
      if (cleanedName.endsWith('CC')) {
        cleanedName = cleanedName.slice(0, -2);
      }
      break;
      
    case 'GA':
      // Retirer GAB au début
      if (cleanedName.startsWith('GAB')) {
        cleanedName = cleanedName.substring(3);
      }
      break;
      
    case 'TD':
      // Retirer TCD au début
      if (cleanedName.startsWith('TCD')) {
        cleanedName = cleanedName.substring(3);
      }
      break;
      
    case 'CF':
      // Retirer RCA au début
      if (cleanedName.startsWith('RCA')) {
        cleanedName = cleanedName.substring(3);
      }
      break;
      
    case 'CG':
      // Retirer CG au début
      if (cleanedName.startsWith('CG')) {
        cleanedName = cleanedName.substring(2);
      }
      break;
  }
  
  return cleanedName;
}

/**
 * Formater les services pour la réponse (nettoyer les noms des merchants)
 */
function formatServicesResponse(services, countryCode) {
  return services.map(service => ({
    ...service,
    merchant: cleanMerchantName(service.merchant, countryCode),
    // Garder le merchant original si besoin pour des traitements internes
    originalMerchant: service.merchant
  }));
}

/**
 * Récupérer les services Smobilpay
 */
async function getServices(countryCode = null) {
  try {
    const endpoint = '/cashout';
    const fullUrl = `${API_URL}${endpoint}`;
    
    const authHeader = generateAuthHeader('GET', fullUrl);
    
    const response = await axios.get(fullUrl, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });
    
    let services = [];
    
    if (response.data && response.data.data && Array.isArray(response.data.data)) {
      services = response.data.data;
    } else if (response.data && Array.isArray(response.data)) {
      services = response.data;
    }
    
    // Filtrer par pays si spécifié
    if (countryCode) {
      services = filterServicesByCountry(services, countryCode);
      // Formater les noms des merchants pour la réponse
      services = formatServicesResponse(services, countryCode);
    }
    
    return services;
  } catch (error) {
    if (error.response) {
      throw new SmobilpayError(
        error.response.data.usrMsg || error.response.data.devMsg || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

/**
 * Demander un devis
 */
async function requestQuote(payItemId, amount) {
  try {
    const endpoint = '/quotestd';
    const fullUrl = `${API_URL}${endpoint}`;
    
    const data = { payItemId, amount };
    
    const authHeader = generateAuthHeader('POST', fullUrl, {}, data);
    
    const response = await axios.post(fullUrl, data, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new SmobilpayError(
        error.response.data.usrMsg || error.response.data.devMsg || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

/**
 * Exécuter un paiement
 */
async function collectPayment(quoteId, customerData, paymentId) {
  try {
    const endpoint = '/collectstd';
    const fullUrl = `${API_URL}${endpoint}`;
    
    const data = {
      quoteId,
      customerPhonenumber: customerData.phoneNumber,
      customerEmailaddress: customerData.email || '',
      customerName: customerData.customerName,
      serviceNumber: customerData.phoneNumber,
      trid: paymentId
    };
    
    const authHeader = generateAuthHeader('POST', fullUrl, {}, data);
    
    const response = await axios.post(fullUrl, data, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new SmobilpayError(
        error.response.data.usrMsg || error.response.data.devMsg || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

/**
 * Vérifier le statut d'une transaction
 */
async function verifyTransaction(identifier, isPaymentId = false) {
  try {
    const endpoint = '/verifytx';
    const fullUrl = `${API_URL}${endpoint}`;
    
    const queryParams = isPaymentId ? { trid: identifier } : { ptn: identifier };
    
    const authHeader = generateAuthHeader('GET', fullUrl, queryParams);
    
    const response = await axios.get(fullUrl, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      params: queryParams
    });
    
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new SmobilpayError(
        error.response.data.usrMsg || error.response.data.devMsg || error.message,
        error.response.status,
        error.response.data
      );
    }
    throw error;
  }
}

/**
 * Initier un paiement complet (VERSION CORRIGÉE POUR MAP)
 */
async function initiatePayment(userId, packageId, serviceId, customerData) {
  try {
    // 1. Récupérer le service
    const services = await getServices();
    const service = services.find(s => s.serviceid === serviceId);
    
    if (!service) {
      throw new AppError(`Service ${serviceId} non trouvé`, 404, ErrorCodes.NOT_FOUND);
    }
    
    // 2. Récupérer le package
    const packageDoc = await Package.findById(packageId);
    if (!packageDoc) {
      throw new AppError('Package non trouvé', 404, ErrorCodes.NOT_FOUND);
    }
    
    // 3. Récupérer le prix en XAF depuis la Map Mongoose
    let amount;
    
    if (packageDoc.pricing instanceof Map) {
      // C'est une Map Mongoose - utiliser .get()
      amount = packageDoc.pricing.get('XAF');
    } else if (packageDoc.pricing && typeof packageDoc.pricing === 'object') {
      // C'est un objet classique
      amount = packageDoc.pricing.XAF || packageDoc.pricing['XAF'];
    }
      
    if (!amount || amount <= 0) {
      throw new AppError('Prix XAF non disponible pour ce package', 400, ErrorCodes.VALIDATION_ERROR);
    }
    
    // 4. Créer la transaction
    const paymentId = uuidv4();
    
    const transaction = new SmobilpayTransaction({
      paymentId,
      user: userId,
      package: packageId,
      serviceId,
      operatorName: service.name || service.serviceName,
      payItemId: service.payItemId,
      amount,
      currency: 'XAF',
      phoneNumber: customerData.phoneNumber,
      customerName: customerData.customerName,
      email: customerData.email,
      status: 'PENDING'
    });
    
    await transaction.save();
    
    // 5. Demander un devis
    const quote = await requestQuote(service.payItemId, amount);
    
    // 6. Mettre à jour avec le quoteId
    transaction.quoteId = quote.quoteId;
    await transaction.save();
    
    // 7. Exécuter le paiement
    const collectResult = await collectPayment(quote.quoteId, customerData, paymentId);
    
    // 8. Mettre à jour avec le PTN
    transaction.ptn = collectResult.ptn;
    await transaction.save();
    
    // 9. Populer et retourner
    await transaction.populate(['package', 'user']);
    
    return transaction;
  } catch (error) {
    throw error;
  }
}

/**
 * Vérifier le statut d'une transaction
 */
async function checkTransactionStatus(paymentId) {
  try {
    // Trouver la transaction
    const transaction = await SmobilpayTransaction.findOne({ paymentId })
      .populate(['package', 'user']);
    
    if (!transaction) {
      throw new AppError('Transaction non trouvée', 404, ErrorCodes.NOT_FOUND);
    }
    
    let apiResponse;
    
    // Vérifier par PTN ou paymentId
    if (transaction.ptn) {
      apiResponse = await verifyTransaction(transaction.ptn);
    } else {
      apiResponse = await verifyTransaction(paymentId, true);
    }
    
    // Traiter la réponse API
    const transactionData = Array.isArray(apiResponse) ? apiResponse[0] : apiResponse;
    
    if (transactionData) {
      // Mettre à jour les champs
      const fieldsToUpdate = [
        'ptn', 'status', 'timestamp', 'receiptNumber', 'veriCode',
        'clearingDate', 'priceLocalCur', 'pin', 'tag', 'errorCode'
      ];
      
      fieldsToUpdate.forEach(field => {
        if (transactionData[field]) {
          if (field === 'timestamp' || field === 'clearingDate') {
            transaction[field] = new Date(transactionData[field]);
          } else if (field === 'priceLocalCur') {
            transaction.priceLocalCur = transactionData[field];
          } else if (field === 'localCur') {
            transaction.currency = transactionData[field];
          } else {
            transaction[field] = transactionData[field];
          }
        }
      });
      
      await transaction.save();
    }
    
    return transaction;
  } catch (error) {
    throw error;
  }
}

module.exports = {
  getServices,
  initiatePayment,
  checkTransactionStatus,
  verifyTransaction,
  formatServicesResponse,
  cleanMerchantName,
  SmobilpayError,
  COUNTRY_MAPPING
};