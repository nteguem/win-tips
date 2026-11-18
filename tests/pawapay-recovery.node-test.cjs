const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../src/api/services/user/PawapayService.js'),'utf8');
const ID='11111111-1111-4111-8111-111111111111';
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture({array=false,country='CMR',provider='MTN_MOMO_CMR',currency='XAF',authType='PROVIDER_AUTH'}={}) {
  const operation={minAmount:'1',maxAmount:'1000000',authType,pinPrompt:'MANUAL',decimalsInAmount:'NONE',status:'OPERATIONAL'};
  return {countries:[{country,providers:[{provider,currencies:[{currency,operationTypes:array?[{DEPOSIT:operation}]:{DEPOSIT:operation}}]}]}]};
}
function harness(options={}) {
  const rows=new Map(),calls=[];
  const pkg={_id:'a'.repeat(24),isActive:true,name:{fr:'Accès VIP'},duration:1,categories:[],pricing:{XAF:1000,XOF:1000,CDF:3902}};
  let conf=options.conf || fixture(),receipt,postError,statusCallback,postCallback;
  class Tx {
    static modelName='PawapayTransaction';
    constructor(data){Object.assign(this,{_id:'b'.repeat(24),processed:false},data);}
    async save(){rows.set(this.depositId,this);return this;}
    async populate(){return this;}
    static findOne(filter){const row=rows.get(filter.depositId);return {populate:async()=>row && (!filter.user || row.user===filter.user)?row:null};}
    static findOneAndUpdate(filter,update){const row=rows.get(filter.depositId);if (!row || (filter.status?.$ne && row.status===filter.status.$ne)) return {populate:async()=>null};Object.assign(row,update.$set);return {populate:async()=>row};}
  }
  const axios={get:async(url,config)=>{calls.push({method:'GET',url,config});if (url.includes('active-conf')) return {data:copy(conf)};if(statusCallback)statusCallback();return {data:copy(receipt)};},post:async(url,payload,config)=>{calls.push({method:'POST',url,payload:copy(payload),config});if(postCallback)postCallback();if(postError)throw postError;return {data:options.initResponse || {depositId:ID,status:'ACCEPTED'}};}};
  class AppError extends Error {constructor(message,statusCode){super(message);this.statusCode=statusCode;}}
  const module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,URL,Date,Buffer,console,process:{env:{PAWAPAY_ENVIRONMENT:'production',PAWAPAY_PROD_TOKEN:'test_live',PAWAPAY_SANDBOX_TOKEN:'test_sandbox',APP_BASE_URL:'https://example.invalid'}},require(name){if(name==='axios')return axios;if(name==='crypto')return crypto;if(name==='uuid')return {v4:()=>ID};if(name.endsWith('PawapayTransaction'))return Tx;if(name.endsWith('/Package'))return {findById:async()=>pkg};if(name.endsWith('mobileMoneySettlement'))return {capturePurchaseSnapshot:(p,c,a)=>({amount:a,currency:c,duration:p.duration,categories:[]})};if(name.endsWith('AppError'))return {AppError,ErrorCodes:{VALIDATION_ERROR:'VALIDATION_ERROR',NOT_FOUND:'NOT_FOUND'}};throw Error(name);}});
  const api=module.exports;
  const seed=(values={})=>{const row=new Tx({depositId:ID,user:'owner',package:pkg._id,status:'INITIATED',amount:1000,currency:'XAF',provider:'MTN_MOMO_CMR',phoneNumber:'237699000000',environment:'production',...values});rows.set(ID,row);return row;};
  const paid=()=>({status:'FOUND',data:{depositId:ID,status:'COMPLETED',amount:'1000',currency:'XAF',payer:{accountDetails:{provider:'MTN_MOMO_CMR',phoneNumber:'237699000000'}}}});
  return {api,rows,calls,pkg,seed,paid,setReceipt(value){receipt=value;},setPostError(value){postError=value;},setStatusCallback(value){statusCallback=value;},setPostCallback(value){postCallback=value;}};
}
test('active configuration supports both documented operationTypes formats',()=>{
  const {api}=harness();for(const array of [false,true]){const c=api.normalizeActiveConf(fixture({array}));assert.equal(c.CM.providers[0].authType,'PROVIDER_AUTH');assert.equal(c.CM.providers[0].pinPrompt,'MANUAL');assert.equal(c.CM.providers[0].minAmount,'1');}
});
test('all historical supported countries keep local currencies and exact country codes',()=>{
  const {api}=harness();for(const [cc,currency] of Object.entries({CM:'XAF',CI:'XOF',SN:'XOF',BJ:'XOF',BF:'XOF',CD:'CDF',GA:'XAF',CG:'XAF',GH:'GHS',KE:'KES',RW:'RWF',UG:'UGX',TZ:'TZS',ZM:'ZMW',NG:'NGN',MW:'MWK',LS:'LSL',MZ:'MZN',SL:'SLE'}))assert.equal(api.currencyForCountry(cc),currency);
  assert.equal(api.currencyForCountry('ZZ'),null);
});
test('provider resolution uses exact enabled catalogue instead of guessed country suffix',()=>{
  const {api}=harness();const c=api.normalizeActiveConf(fixture({country:'COD',provider:'AIRTEL_COD',currency:'CDF'})).CD;assert.equal(api.selectProvider(c,'airtel').provider,'AIRTEL_COD');assert.equal(api.selectProvider(c,null,'AIRTEL_OAPI_COD'),undefined);
});
test('phone normalization preserves Ivory Coast zero and international country prefixes',()=>{
  const {api}=harness();assert.equal(api.normalizePhone('0700000000','CI'),'2250700000000');assert.equal(api.normalizePhone('+237699000000','CM'),'237699000000');assert.equal(api.normalizePhone('00237699000000','CM'),'237699000000');assert.equal(api.normalizePhone('0712345678','KE'),'254712345678');assert.throws(()=>api.normalizePhone('+2348010000000','CM'));
});
test('initiation snapshots rights and price before POST and sends international phone',async()=>{
  const h=harness();const result=await h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM');assert.equal(result.transaction.status,'INITIATED');const post=h.calls.find(c=>c.method==='POST');assert.equal(post.payload.payer.accountDetails.phoneNumber,'237699000000');assert.equal(post.payload.amount,'1000');assert.equal(result.transaction.purchaseSnapshot.amount,1000);assert.equal(h.rows.size,1);
});
test('unavailable provider, closed operation, wrong currency and unavailable package never send POST',async()=>{
  for(const mutate of [h=>{},h=>h.pkg.isActive=false]){const h=harness();mutate(h);await assert.rejects(h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000',null,'CM',h.pkg.isActive?'WRONG':'MTN_MOMO_CMR'));assert.equal(h.calls.filter(c=>c.method==='POST').length,0);}
  const h=harness({conf:fixture({currency:'USD'})});await assert.rejects(h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM'));assert.equal(h.rows.size,0);
});
test('operator amount limits and decimals reject before charging',()=>{
  const {api}=harness();for(const amount of [0,-1,NaN,Infinity,1.123,1001])assert.throws(()=>api.validateAmount(amount,{maxAmount:1000}));assert.throws(()=>api.validateAmount(2.5,{decimalsInAmount:'NONE'}));assert.doesNotThrow(()=>api.validateAmount(2.5,{decimalsInAmount:'TWO_PLACES'}));
});
test('transport timeout after uncertain POST preserves deposit ID for manual/cron verification',async()=>{
  const h=harness();h.setPostError(Object.assign(Error('timeout'),{code:'ETIMEDOUT'}));const result=await h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM');assert.equal(result.transaction.status,'PENDING');assert.equal(result.transaction.depositId,ID);assert.equal(h.rows.size,1);h.setReceipt(h.paid());const recovered=await h.api.checkTransactionStatus(ID,{userId:'owner'});assert.equal(recovered.status,'SUCCESS');
});
test('known initiation refusal remains auditable without fabricating success',async()=>{
  const h=harness();h.setPostError({response:{status:400}});await assert.rejects(h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM'));assert.equal(h.rows.get(ID).status,'FAILED');
});
test('initiation response alone never proves a completed payment',async()=>{
  const h=harness({initResponse:{status:'COMPLETED'}});const result=await h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM');assert.notEqual(result.transaction.status,'SUCCESS');assert.equal(result.transaction.verifiedPaymentAt,undefined);
});
test('a fast verified callback cannot be overwritten by the later initiation response',async()=>{
  for(const error of [undefined,{response:{status:400}},Error('timeout')]) {const h=harness();h.setPostError(error);h.setPostCallback(()=>Object.assign(h.rows.get(ID),{status:'SUCCESS',processed:true,verifiedPaymentAt:new Date()}));const result=await h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM');assert.equal(result.transaction.status,'SUCCESS');assert.equal(result.transaction.processed,true);}
});
test('transaction ownership is checked before any provider request',async()=>{
  const h=harness();h.seed();await assert.rejects(h.api.checkTransactionStatus(ID,{userId:'other'}));assert.equal(h.calls.length,0);await assert.rejects(h.api.checkTransactionStatus('invalid'));assert.equal(h.calls.length,0);
});
test('successful authenticated receipt persists proof for idempotent finalization',async()=>{
  const h=harness();h.seed();h.setReceipt(h.paid());const result=await h.api.checkTransactionStatus(ID,{userId:'owner'});assert.equal(result.status,'SUCCESS');assert.equal(result.verifiedAmount,1000);assert.equal(result.verifiedCurrency,'XAF');assert.ok(result.verifiedPaymentAt);await h.api.checkTransactionStatus(ID,{userId:'owner'});assert.equal(h.calls.length,1);
});
test('amount, currency, reference, provider and payer mismatch never grant success',async()=>{
  for(const mutate of [d=>d.amount='999',d=>d.currency='USD',d=>d.depositId='other',d=>d.payer.accountDetails.provider='OTHER',d=>d.payer.accountDetails.phoneNumber='237699000001']){const h=harness();h.seed();const receipt=h.paid();mutate(receipt.data);h.setReceipt(receipt);await assert.rejects(h.api.checkTransactionStatus(ID));assert.equal(h.rows.get(ID).status,'INITIATED');assert.equal(h.rows.get(ID).verifiedPaymentAt,undefined);}
});
test('NOT_FOUND and unknown states remain recoverable without false expiration',async()=>{
  for(const receipt of [{status:'NOT_FOUND'},{status:'FOUND',data:{status:'NEW_PROVIDER_STATE'}}]){const h=harness();h.seed();h.setReceipt(receipt);assert.equal((await h.api.checkTransactionStatus(ID)).status,'INITIATED');}
});
test('transaction uses its original provider environment after global config changes',async()=>{
  const h=harness();h.seed({environment:'sandbox'});h.setReceipt(h.paid());await h.api.checkTransactionStatus(ID);assert.match(h.calls[0].url,/api.sandbox.pawapay.io/);assert.equal(h.calls[0].config.headers.Authorization,'Bearer test_sandbox');
});
test('late pending response cannot overwrite concurrently verified success',async()=>{
  const h=harness();const row=h.seed();h.setReceipt({status:'FOUND',data:{status:'PROCESSING'}});h.setStatusCallback(()=>Object.assign(row,{status:'SUCCESS',verifiedPaymentAt:new Date()}));assert.equal((await h.api.checkTransactionStatus(ID)).status,'SUCCESS');
});
test('PREAUTH requires code and sends it only for the documented provider authorization',async()=>{
  const h=harness({conf:fixture({authType:'PREAUTH'})});await assert.rejects(h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM'));assert.equal(h.rows.size,0);await h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM',undefined,{preAuthorisationCode:'123456'});assert.equal(h.calls.find(c=>c.method==='POST').payload.preAuthorisationCode,'123456');
});
test('REDIRECT_AUTH sends merchant return URLs and exposes only HTTPS authorization URLs',async()=>{
  const h=harness({conf:fixture({authType:'REDIRECT_AUTH'})});await h.api.initiatePayment({_id:'owner'},h.pkg._id,'699000000','mtn','CM');const post=h.calls.find(c=>c.method==='POST');assert.match(post.payload.successfulUrl,/^https:\/\/example.invalid\/api\/payments\/pawapay\/return/);h.setReceipt({status:'FOUND',data:{status:'PROCESSING',authorizationUrl:'https://wallet.example.invalid/authorize'}});assert.equal((await h.api.checkTransactionStatus(ID)).authorizationUrl,'https://wallet.example.invalid/authorize');
});
