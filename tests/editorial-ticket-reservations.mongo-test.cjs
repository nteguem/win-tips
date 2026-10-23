// Explicit disposable replica set only. No application .env, jobs or FCM.
const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
if (!process.env.WINTIPS_TEST_MONGO_RUNTIME || !process.env.WINTIPS_TEST_MONGO_BINARY) throw new Error('Explicit disposable Mongo runtime/binary required');
process.env.NODE_ENV='test';process.env.DISABLE_PUSH_NOTIFICATIONS='true';
const mongoose=require('mongoose');
const {MongoMemoryReplSet}=require(process.env.WINTIPS_TEST_MONGO_RUNTIME);
const {provision}=require('../tools/editorial-indexes.cjs');
const {createEditorialRepository}=require('../src/api/services/common/editorialRepository');
const {ticketFingerprint}=require('../src/api/services/common/editorialTickets');
const EditorialItem=require('../src/api/models/common/EditorialItem');
const DUO='rdj_football_duo',GOALS='rdj_football_goals',day='2026-10-23';
const category=new mongoose.Types.ObjectId(), category2=new mongoose.Types.ObjectId();
let mongo,repo;
function item(id='74768',mixed=false,date=day){
  return {kind:'combine',sourceId:id,sourceUrl:`https://www.ruedesjoueurs.com/paris-sportifs/sport-news/news-pmu-sport/${id}-combine-${date.split('-').reverse().join('-')}.html`,selection:{totalOdds:2},legs:[1,2].map(n=>({startsAtUtc:date+'T18:00:00Z',teams:{home:{name:'Home'+n},away:{name:'Away'+n}},selection:{betType:mixed&&n===1?'match_winner':'btts',label:{fr:mixed&&n===1?'Victoire Home1':'Les deux équipes marquent'}}}))};
}
function op(source,payload=item(),cat=category,date=day){return {updateOne:{filter:{categoryId:cat,source,editionDate:date,sourceId:payload.sourceId},update:{$set:{kind:'combine',payload,contentHash:'test-only',isPublished:true}},upsert:true}};}
before(async()=>{
  mongo=await MongoMemoryReplSet.create({binary:{systemBinary:process.env.WINTIPS_TEST_MONGO_BINARY},replSet:{count:1,storageEngine:'wiredTiger',spawn:{windowsHide:true}},instanceOpts:[{args:['--wiredTigerCacheSizeGB','0.25','--setParameter','diagnosticDataCollectionEnabled=false']}]});
  const uri=mongo.getUri('wintips_ticket_reservations_disposable');assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:/);
  await mongoose.connect(uri,{autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:10000});
  await provision(mongoose.connection.db,{apply:true,intent:true});
  repo=createEditorialRepository({Category:{},EditorialItem,subscriptionService:{},accessGateService:{}});
},{timeout:180000});
beforeEach(async()=>{await EditorialItem.deleteMany({});await mongoose.connection.db.collection('editorialticketstates').deleteMany({});});
after(async()=>{await mongoose.disconnect();if(mongo)await mongo.stop();});
test('two polls cannot replace the first Duo or publish it as Goals; exact retry updates odds only',async()=>{
  const a=item(),b=item('99999',true);await repo.upsertBatch([op(DUO,a)]);
  await assert.rejects(repo.upsertBatch([op(DUO,b)]),{statusCode:409});
  await assert.rejects(repo.upsertBatch([op(GOALS,a)]),{statusCode:409});
  a.selection.totalOdds=2.4;await repo.upsertBatch([op(DUO,a)]);
  const rows=await EditorialItem.find().lean();assert.equal(rows.length,1);assert.equal(rows[0].payload.selection.totalOdds,2.4);
  const state=await repo.ticketState(day);assert.equal(state.ready,true);assert.equal(state.duo.sourceId,'74768');assert.deepEqual(state.goals,[]);
});
test('Goals first blocks the same Duo; a distinct Duo and multi-category exact retries are valid',async()=>{
  const a=item(),b=item('99999',true);await repo.upsertBatch([op(GOALS,a),op(GOALS,a,category2)]);
  await assert.rejects(repo.upsertBatch([op(DUO,a)]),{statusCode:409});
  await repo.upsertBatch([op(DUO,b)]);await repo.upsertBatch([op(GOALS,a),op(GOALS,a,category2)]);
  assert.equal(await EditorialItem.countDocuments(),3);assert.equal((await repo.ticketState(day)).goals.length,1);
});
test('simultaneous opposite-family imports reserve a composition exactly once',async()=>{
  const results=await Promise.allSettled([repo.upsertBatch([op(DUO)]),repo.upsertBatch([op(GOALS)])]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.statusCode,409);
  assert.equal(await EditorialItem.countDocuments(),1);assert.equal((await repo.ticketState(day)).ready,true);
});
test('simultaneous distinct Duo candidates keep the first global composition, even across categories',async()=>{
  const results=await Promise.allSettled([repo.upsertBatch([op(DUO)]),repo.upsertBatch([op(DUO,item('99999',true),category2)])]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.statusCode,409);assert.equal(await EditorialItem.countDocuments(),1);
});
test('legacy rows without reservations are protected without rewriting them',async()=>{
  const operation=op(DUO);await EditorialItem.bulkWrite([operation]);const before=await EditorialItem.findOne().lean();
  const state=await repo.ticketState(day);assert.equal(state.ready,true);assert.equal(state.duo.fingerprint,ticketFingerprint(item()));
  const copied=item('88888');await assert.rejects(repo.upsertBatch([op(GOALS,copied)]),{statusCode:409});
  assert.deepEqual(await EditorialItem.findOne().lean(),before);assert.equal(await EditorialItem.countDocuments(),1);
});
test('conflicting or malformed legacy data fails closed and never publishes another item',async()=>{
  await EditorialItem.bulkWrite([op(DUO),op(GOALS)]);assert.equal((await repo.ticketState(day)).ready,false);
  await assert.rejects(repo.upsertBatch([op(DUO,item('99999',true))]),{statusCode:409});assert.equal(await EditorialItem.countDocuments(),2);
  await EditorialItem.deleteMany({});await EditorialItem.bulkWrite([op(DUO,{kind:'combine',sourceId:'74768',testOnly:true})]);
  assert.equal((await repo.ticketState(day)).ready,false);await assert.rejects(repo.upsertBatch([op(GOALS)]),{statusCode:409});
});
test('bulk failure rolls back the reservation with the content; a subsequent other-family import can succeed',async()=>{
  const broken=createEditorialRepository({Category:{},EditorialItem:{db:EditorialItem.db,collection:EditorialItem.collection,bulkWrite:async()=>{throw new Error('synthetic content write failure');}},subscriptionService:{},accessGateService:{}});
  await assert.rejects(broken.upsertBatch([op(DUO)]),/synthetic content write failure/);
  const state=await repo.ticketState(day);assert.equal(state.duo,null);assert.deepEqual(state.goals,[]);assert.equal(await EditorialItem.countDocuments(),0);
  await repo.upsertBatch([op(GOALS)]);assert.equal(await EditorialItem.countDocuments(),1);
});
test('next edition is independent and a changed composition under the same publisher ID is rejected',async()=>{
  await repo.upsertBatch([op(DUO)]);
  const changed=item();changed.legs[0].selection.label.fr+=' : Non';await assert.rejects(repo.upsertBatch([op(DUO,changed)]),{statusCode:409});
  await repo.upsertBatch([op(GOALS,item('74768',false,'2026-10-24'),category,'2026-10-24')]);assert.equal(await EditorialItem.countDocuments(),2);
});
test('Goals cannot replace a published composition under the same identity in either family',async()=>{
  await repo.upsertBatch([op(GOALS)]);const changed=item();changed.legs[0].selection.label.fr+=' : Non';
  await assert.rejects(repo.upsertBatch([op(GOALS,changed)]),{statusCode:409});await assert.rejects(repo.upsertBatch([op(DUO,changed)]),{statusCode:409});
  changed.sourceUrl=changed.sourceUrl.replace('-combine-','-combine-mis-a-jour-');await assert.rejects(repo.upsertBatch([op(GOALS,changed)]),{statusCode:409});
  const renamed=item();renamed.sourceUrl=changed.sourceUrl;await assert.rejects(repo.upsertBatch([op(GOALS,renamed)]),{statusCode:409});
  const rows=await EditorialItem.find().lean();assert.equal(rows.length,1);assert.equal(rows[0].payload.legs[0].selection.label.fr,'Les deux équipes marquent');assert.equal((await repo.ticketState(day)).goals.length,1);
});
test('a malformed reservation identity blocks rather than writing without an edition lock',async()=>{
  const states=mongoose.connection.db.collection('editorialticketstates');
  await states.insertOne({_id:'malformed',editionDate:day,version:'rdj-ticket-v1',duo:null,goals:[],revision:0});
  assert.equal((await repo.ticketState(day)).ready,false);await assert.rejects(repo.upsertBatch([op(DUO)]),{statusCode:409});assert.equal(await EditorialItem.countDocuments(),0);
  await states.deleteMany({});await states.insertOne({_id:day,editionDate:'2026-10-24',version:'rdj-ticket-v1',duo:null,goals:[],revision:0});
  assert.equal((await repo.ticketState(day)).ready,false);await assert.rejects(repo.upsertBatch([op(GOALS)]),{statusCode:409});assert.equal(await EditorialItem.countDocuments(),0);
});
test('unprovisioned reservation index blocks ticket writes without implicit collection creation',async()=>{
  await mongoose.connection.db.collection('editorialticketstates').drop();
  assert.equal((await repo.ticketState(day)).ready,false);await assert.rejects(repo.upsertBatch([op(DUO)]),{statusCode:503});assert.equal(await EditorialItem.countDocuments(),0);
  assert.equal((await mongoose.connection.db.listCollections({name:'editorialticketstates'}).toArray()).length,0);
  await provision(mongoose.connection.db,{apply:true,intent:true});
});
