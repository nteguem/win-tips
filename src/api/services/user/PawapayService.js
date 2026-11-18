'use strict';
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const PawapayTransaction = require('../../models/user/PawapayTransaction');
const Package = require('../../models/common/Package');
const { capturePurchaseSnapshot } = require('../common/mobileMoneySettlement');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

class PawapayError extends Error {
  constructor(message, statusCode = 503) { super(message); this.name='PawapayError'; this.statusCode=statusCode; }
}
const ISO3 = {CM:'CMR',CI:'CIV',SN:'SEN',BJ:'BEN',BF:'BFA',CD:'COD',GA:'GAB',CG:'COG',GH:'GHA',KE:'KEN',RW:'RWA',UG:'UGA',TZ:'TZA',ZM:'ZMB',NG:'NGA',MW:'MWI',LS:'LSO',MZ:'MOZ',SL:'SLE'};
const PREFIX = {CM:'237',CI:'225',SN:'221',BJ:'229',BF:'226',CD:'243',GA:'241',CG:'242',GH:'233',KE:'254',RW:'250',UG:'256',TZ:'255',ZM:'260',NG:'234',MW:'265',LS:'266',MZ:'258',SL:'232'};
const CURRENCIES = {CM:'XAF',CG:'XAF',GA:'XAF',CI:'XOF',SN:'XOF',BJ:'XOF',BF:'XOF',CD:'CDF',GH:'GHS',KE:'KES',UG:'UGX',TZ:'TZS',ZM:'ZMW',NG:'NGN',RW:'RWF',MW:'MWK',LS:'LSL',MZ:'MZN',SL:'SLE'};
const ALIASES = {om:['ORANGE'],orange:['ORANGE'],mtn:['MTN_MOMO'],airtel:['AIRTEL','AIRTEL_OAPI'],mpesa:['MPESA','VODACOM_MPESA'],vodacom:['VODACOM','VODACOM_MPESA'],moov:['MOOV'],tigo:['TIGO','AIRTELTIGO'],wave:['WAVE'],free:['FREE'],vodafone:['VODAFONE'],zamtel:['ZAMTEL'],tnm:['TNM']};
const invalid = message => new AppError(message,400,ErrorCodes.VALIDATION_ERROR);
const currencyForCountry = cc => CURRENCIES[String(cc || '').toUpperCase()] || null;
function detectCountryFromPhone(phone) {
  const digits=String(phone || '').replace(/\D/g,'').replace(/^00/,'');
  return Object.keys(PREFIX).find(cc=>digits.startsWith(PREFIX[cc])) || null;
}
function normalizePhone(phone,country) {
  const cc=String(country || '').toUpperCase(),prefix=PREFIX[cc];
  let digits=String(phone || '').replace(/\D/g,'').replace(/^00/,'');
  if (!digits || !prefix) return '';
  if (digits.startsWith(prefix) && digits.length>=prefix.length+7) return digits;
  if (/^\+|^00/.test(String(phone || '').trim())) throw invalid('Le numéro ne correspond pas au pays choisi');
  if (cc!=='CI' && digits.startsWith('0')) digits=digits.slice(1);
  return prefix+digits;
}
function buildProviderCode(country,operator) {
  const code=ISO3[String(country || '').toUpperCase()],aliases=ALIASES[String(operator || '').toLowerCase()];
  if (!code || !aliases) throw invalid('Pays ou opérateur non reconnu');
  return `${aliases[0]}_${code}`; // Initiation resolves this against the real catalogue.
}
function getConfig(environment) {
  const env=environment || (process.env.PAWAPAY_ENVIRONMENT==='production'?'production':'sandbox');
  if (!['production','sandbox'].includes(env)) throw new PawapayError('Environnement pawaPay invalide');
  const live=env==='production',token=live?process.env.PAWAPAY_PROD_TOKEN:process.env.PAWAPAY_SANDBOX_TOKEN;
  if (!token) throw new PawapayError('pawaPay non configuré');
  return {environment:env,token,apiUrl:(live?process.env.PAWAPAY_PROD_API_URL || 'https://api.pawapay.io':process.env.PAWAPAY_SANDBOX_API_URL || 'https://api.sandbox.pawapay.io').replace(/\/+$/,'')};
}
const requestOptions = config => ({headers:{Authorization:`Bearer ${config.token}`,Accept:'application/json','Content-Type':'application/json'},timeout:15000});
function generateUrls() {
  const base=(process.env.APP_BASE_URL || '').replace(/\/+$/,'');
  if (!/^https:\/\//.test(base)) throw new PawapayError('URL de retour pawaPay non configurée');
  return {callback_url:`${base}/api/payments/pawapay/webhook`,successfulUrl:`${base}/api/payments/pawapay/return?result=success`,failedUrl:`${base}/api/payments/pawapay/return?result=failed`};
}
function mapApiStatus(value) {
  const s=String(value || '').toUpperCase();
  if (s==='COMPLETED') return 'SUCCESS';
  if (['FAILED','REJECTED'].includes(s)) return 'FAILED';
  if (s==='EXPIRED') return 'EXPIRED';
  if (['ACCEPTED','PROCESSING','SUBMITTED','IN_RECONCILIATION','ENQUEUED','DUPLICATE_IGNORED','PENDING','AUTHORIZATION_REQUIRED'].includes(s)) return 'INITIATED';
  return null;
}
function depositOperation(value) {
  return Array.isArray(value)?value.find(op=>op?.DEPOSIT)?.DEPOSIT || null:value?.DEPOSIT || null;
}
function normalizeActiveConf(raw) {
  const result={};
  for (const c of raw?.countries || []) {
    const cc=Object.keys(ISO3).find(key=>ISO3[key]===c.country);
    if (!cc) continue;
    const countryCurrency=currencyForCountry(cc);
    const providers=(c.providers || []).map(p=>{
      const currencies=(p.currencies || []).flatMap(cur=>{
        const dep=depositOperation(cur.operationTypes);
        return dep?[{currency:cur.currency,...dep}]:[];
      });
      const cur=currencies.find(value=>value.currency===countryCurrency) || currencies[0];
      if (!cur) return null;
      return {provider:p.provider,displayName:p.displayName || p.nameDisplayedToCustomer || p.provider,logo:p.logo,
        currency:cur.currency,currencies,minAmount:cur.minAmount ?? null,maxAmount:cur.maxAmount ?? null,
        status:cur.status || null,authType:cur.authType || null,decimalsInAmount:cur.decimalsInAmount || null,
        pinPrompt:cur.pinPrompt || null,pinPromptRevivable:cur.pinPromptRevivable ?? null,
        pinInstructions:cur.pinPromptInstructions ? {channels:(cur.pinPromptInstructions.channels || []).map(ch=>({...ch,shortCode:ch.shortCode || ch.variables?.shortCode || null}))}:null};
    }).filter(Boolean);
    if (providers.length) result[cc]={country:cc,iso3:c.country,displayName:c.displayName,prefix:c.prefix,flag:c.flag,currency:countryCurrency || providers[0].currency,providers};
  }
  return result;
}
let cached=null;
function clearProvidersCache() { cached=null; }
async function getProvidersAsync(countryFilter=null) {
  const config=getConfig(),key=config.environment+crypto.createHash('sha256').update(config.token).digest('hex');
  if (!cached || cached.key!==key || cached.expires<Date.now()) {
    const response=await axios.get(`${config.apiUrl}/v2/active-conf?operationType=DEPOSIT`,requestOptions(config));
    cached={key,expires:Date.now()+15*60*1000,countries:normalizeActiveConf(response.data)};
  }
  const countries=cached.countries;
  return countryFilter?{country:countries[String(countryFilter).toUpperCase()] || null,availableCountries:Object.keys(countries)}
    :{countries:Object.values(countries),availableCountries:Object.keys(countries)};
}
function selectProvider(country,operator,requestedProvider) {
  const providers=country?.providers || [];
  if (requestedProvider) return providers.find(p=>p.provider===String(requestedProvider).toUpperCase());
  const aliases=ALIASES[String(operator || '').toLowerCase()] || [String(operator || '').toUpperCase()];
  return providers.find(p=>aliases.some(alias=>p.provider===alias || p.provider===`${alias}_${country.iso3}`));
}
function validateAmount(amount,configuration) {
  if (typeof amount!=='number' || !Number.isFinite(amount) || amount<=0) throw invalid('Prix non disponible pour cette devise');
  if ((configuration.minAmount!=null && amount<Number(configuration.minAmount)) || (configuration.maxAmount!=null && amount>Number(configuration.maxAmount))) throw invalid('Montant hors des limites de cet opérateur');
  if (configuration.decimalsInAmount==='NONE' && !Number.isInteger(amount)) throw invalid('Cet opérateur exige un montant entier');
  if (Math.abs(amount*100-Math.round(amount*100))>0.000001) throw invalid('Montant invalide');
}
function authorizationUrl(data) {
  const value=data?.authorizationUrl;
  if (!value) return undefined;
  try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password?url.href:undefined;} catch {return undefined;}
}
async function initiatePayment(user,packageId,phoneNumber,operator,requestedCountry,requestedProvider,options={}) {
  const config=getConfig(),countryCode=String(requestedCountry || detectCountryFromPhone(phoneNumber) || '').toUpperCase();
  const catalogue=(await getProvidersAsync(countryCode)).country;
  if (!catalogue) throw invalid('Pays non disponible sur ce compte pawaPay');
  const providerConfig=selectProvider(catalogue,operator,requestedProvider);
  if (!providerConfig || providerConfig.status==='CLOSED') throw invalid('Opérateur indisponible pour ce pays');
  const currency=currencyForCountry(countryCode),capability=providerConfig.currencies.find(cur=>cur.currency===currency);
  if (!capability || capability.status==='CLOSED') throw invalid('Devise indisponible chez cet opérateur');
  const pkg=await Package.findById(packageId);
  if (!pkg || !pkg.isActive || pkg.paymentMode==='ads') throw invalid('Forfait indisponible');
  const amount=pkg.pricing?.get?pkg.pricing.get(currency):pkg.pricing?.[currency];
  validateAmount(amount,capability);
  const phone=normalizePhone(phoneNumber,countryCode);
  if (!/^\d{8,15}$/.test(phone) || !phone.startsWith(PREFIX[countryCode])) throw invalid('Numéro de téléphone invalide');
  const payload={depositId:uuidv4(),payer:{type:'MMO',accountDetails:{phoneNumber:phone,provider:providerConfig.provider}},amount:String(amount),currency};
  if (capability.authType==='PREAUTH') {
    if (!/^\d{4,12}$/.test(String(options.preAuthorisationCode || ''))) throw invalid('Le code de préautorisation est requis');
    payload.preAuthorisationCode=String(options.preAuthorisationCode);
  } else if (capability.authType==='REDIRECT_AUTH') {
    const urls=generateUrls();payload.successfulUrl=urls.successfulUrl;payload.failedUrl=urls.failedUrl;
  }
  payload.clientReferenceId=`WT-${Date.now()}-${payload.depositId.slice(0,8)}`;
  payload.customerMessage=String(pkg.name?.fr || pkg.name?.en || 'WinTips VIP').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9 ]/g,' ').replace(/\s+/g,' ').trim().slice(0,22) || 'WinTips VIP';
  const transaction=new PawapayTransaction({depositId:payload.depositId,clientReferenceId:payload.clientReferenceId,user:user._id,package:pkg._id,countryCode,amount,currency,status:'PENDING',provider:providerConfig.provider,phoneNumber:phone,environment:config.environment,customerMessage:payload.customerMessage,purchaseSnapshot:capturePurchaseSnapshot(pkg,currency,amount)});
  await transaction.save(); // An uncertain POST must remain reconcilable by ID.
  const persistInitiation = async update => {
    const updated=await PawapayTransaction.findOneAndUpdate({depositId:transaction.depositId,status:{$ne:'SUCCESS'}},{$set:update},{new:true}).populate(['package','user']);
    return updated || await PawapayTransaction.findOne({depositId:transaction.depositId}).populate(['package','user']);
  };
  let response;
  try {response=await axios.post(`${config.apiUrl}/v2/deposits`,payload,requestOptions(config));}
  catch(error) {
    const status=error.response?.status;
    if (status && status<500 && ![408,409,429].includes(status)) {
      const rejected=await persistInitiation({status:'FAILED',failureCode:'INITIATION_REJECTED'});
      if (rejected.status==='SUCCESS') return {transaction:rejected};
      throw new PawapayError('Le paiement a été refusé par pawaPay',400);
    }
    return {transaction:await persistInitiation({failureCode:'INITIATION_UNCONFIRMED'})};
  }
  const data=response.data || {};
  // No initiation response alone can grant paid access.
  return {transaction:await persistInitiation({providerData:data,status:data.status==='REJECTED'?'FAILED':'INITIATED',
    authorizationUrl:authorizationUrl(data),failureCode:data.failureReason?.failureCode,failureMessage:data.failureReason?.failureMessage})};
}
function verifyReceipt(transaction,data) {
  const account=data.payer?.accountDetails || {};
  const amount=typeof data.amount==='number' || (typeof data.amount==='string' && /^\d+(\.\d+)?$/.test(data.amount))?Number(data.amount):NaN;
  if (data.depositId!==transaction.depositId || String(data.currency || '').toUpperCase()!==transaction.currency || !Number.isFinite(amount) || amount!==transaction.amount || (account.provider || data.provider)!==transaction.provider || (account.phoneNumber && account.phoneNumber!==transaction.phoneNumber)) {
    throw new PawapayError('Le reçu pawaPay ne correspond pas à cette transaction',409);
  }
}
async function checkTransactionStatus(depositId,options={}) {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(String(depositId))) throw invalid('Référence pawaPay invalide');
  const filter={depositId};if (options.userId) filter.user=options.userId;
  const transaction=await PawapayTransaction.findOne(filter).populate(['package','user']);
  if (!transaction) throw new AppError('Transaction introuvable',404,ErrorCodes.NOT_FOUND);
  if (transaction.status==='SUCCESS' && transaction.verifiedPaymentAt) return transaction;
  const config=getConfig(transaction.environment);
  const response=await axios.get(`${config.apiUrl}/v2/deposits/${depositId}`,requestOptions(config));
  const raw=response.data || {},data=raw.data || raw;
  if (raw.status==='NOT_FOUND') return transaction;
  const status=mapApiStatus(data.status),update={providerData:raw,lastCheckedAt:new Date()};
  if (status==='SUCCESS') {
    verifyReceipt(transaction,data);
    Object.assign(update,{status,verifiedPaymentAt:new Date(),verifiedAmount:Number(data.amount),verifiedCurrency:data.currency});
  } else if (status) update.status=status;
  const url=authorizationUrl(data);if (url) update.authorizationUrl=url;
  if (data.failureReason) {update.failureCode=data.failureReason.failureCode;update.failureMessage=data.failureReason.failureMessage;}
  const guard=status==='SUCCESS'?filter:{...filter,status:{$ne:'SUCCESS'}};
  const updated=await PawapayTransaction.findOneAndUpdate(guard,{$set:update},{new:true}).populate(['package','user']);
  return updated || await PawapayTransaction.findOne(filter).populate(['package','user']);
}
function verifyContentDigest(body,header) {
  const match=/sha-256=:([^:]+):/i.exec(header || '');
  return !!match && crypto.createHash('sha256').update(body).digest('base64')===match[1];
}
module.exports={getConfig,generateUrls,initiatePayment,checkTransactionStatus,getProvidersAsync,clearProvidersCache,mapApiStatus,detectCountryFromPhone,buildProviderCode,currencyForCountry,normalizePhone,verifyContentDigest,normalizeActiveConf,depositOperation,selectProvider,validateAmount,verifyReceipt,PawapayError};
