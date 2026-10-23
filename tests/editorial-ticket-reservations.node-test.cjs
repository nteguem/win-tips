const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const t = require('../src/api/services/common/editorialTickets');
const { createEditorialService } = require('../src/api/services/common/editorialService');
const clone = value => JSON.parse(JSON.stringify(value));
function item(id = '74768', kind = 'btts', date = '2026-10-23') {
  const names = [['VfB Stuttgart','M Gladbach'],['Brest','OGC Nice']];
  return { sourceId: id, sourceUrl: `https://www.ruedesjoueurs.com/paris-sportifs/sport-news/news-pmu-sport/${id}-combine-${date.split('-').reverse().join('-')}.html`, kind: 'combine', selection: { totalOdds: 2 },
    legs: names.map(([home,away], i) => ({ sourceId: String(i), startsAtUtc: date + 'T18:00:00Z', teams: { home: { name: home }, away: { name: away } }, selection: { betType: kind, label: { fr: kind === 'btts' ? 'Les deux équipes marquent' : 'Plus de 2,50 buts' } } })) };
}
test('composition ignores article IDs, prose, odds and leg order; retains opponents, UTC, polarity and exact threshold', () => {
  const a = item(), b = clone(a); b.sourceId = '99999'; b.title = { fr: 'Autre titre' }; b.selection.totalOdds = 3; b.legs.reverse();
  assert.equal(t.ticketFingerprint(a), t.ticketFingerprint(b));
  const alias = clone(a); alias.legs[0].teams.home.name = 'Stuttgat'; alias.legs[0].teams.away.name = 'Borussia Mönchengladbach';
  assert.equal(t.ticketFingerprint(a), t.ticketFingerprint(alias));
  for (const mutate of [row => row.legs[0].startsAtUtc = '2026-10-23T18:01:00Z', row => row.legs[0].teams.home.name = 'Lyon', row => [row.legs[0].teams.home,row.legs[0].teams.away] = [row.legs[0].teams.away,row.legs[0].teams.home], row => row.legs[0].selection.label.fr += ' : Non']) {
    const row = clone(a); mutate(row); assert.notEqual(t.ticketFingerprint(a),t.ticketFingerprint(row));
  }
  const over = item('74768','over_under_goals'), formatted = clone(over); formatted.legs.forEach(leg => leg.selection.label.fr = '+ 2.5 buts');
  assert.equal(t.ticketFingerprint(over),t.ticketFingerprint(formatted));
  formatted.legs[0].selection.label.fr = 'Moins de 2,5 buts'; assert.notEqual(t.ticketFingerprint(over),t.ticketFingerprint(formatted));
  formatted.legs[0].selection.label.fr = 'Plus de 3,5 buts'; assert.notEqual(t.ticketFingerprint(over),t.ticketFingerprint(formatted));
});
test('both family directions and copied articles conflict; exact retry and next edition remain independent', () => {
  for (const first of t.TICKET_SOURCES) {
    const state = t.emptyState('2026-10-23'), entry = t.entryFor(item()); t.reserve(state,first,entry); t.reserve(state,first,entry);
    const copied = { ...entry, sourceId: '99999', sourceUrl: entry.sourceUrl.replace('/74768-','/99999-') };
    assert.throws(() => t.reserve(state,t.TICKET_SOURCES.find(key => key !== first),copied), { statusCode: 409 });
    assert.throws(() => t.reserve(state,first,copied), { statusCode: 409 });
    const changed=item();changed.legs[0].selection.label.fr+=' : Non';
    assert.throws(() => t.reserve(state,first,t.entryFor(changed)), { statusCode:409 });
    assert.throws(() => t.reserve(state,t.TICKET_SOURCES.find(key=>key!==first),t.entryFor(changed)), { statusCode:409 });
    const renamed=clone(entry);renamed.sourceUrl=renamed.sourceUrl.replace('-combine-','-combine-mis-a-jour-');
    assert.throws(() => t.reserve(state,first,renamed), { statusCode:409 });
    changed.sourceUrl=renamed.sourceUrl;assert.throws(() => t.reserve(state,first,t.entryFor(changed)), { statusCode:409 });
    assert.doesNotThrow(() => t.reserve(t.emptyState('2026-10-24'),first,t.entryFor(item('74768','btts','2026-10-24'))));
  }
});
test('legacy rows reconstruct reservations and existing contradictory rows fail closed', () => {
  const payload = item(), row = { source: t.TICKET_SOURCES[0], sourceId: payload.sourceId, editionDate:'2026-10-23', payload };
  const state=t.mergeState(row.editionDate,null,[row,row]); assert.equal(state.duo.fingerprint,t.ticketFingerprint(payload));
  assert.throws(() => t.mergeState(row.editionDate,null,[row,{ ...row,source:t.TICKET_SOURCES[1] }]), { statusCode:409 });
  assert.throws(() => t.mergeState(row.editionDate,null,[{ ...row,payload:{ testOnly:true } }]), { statusCode:409 });
});
test('Python collector and server have byte-identical composition fingerprints for all football market families', () => {
  const cases=[item(),item('74768','over_under_goals')];
  for (const label of ['Les deux équipes marquent — Non','Les 2 équipes marquent – Oui','Les deux équipes marquent : Non','Les deux équipes marquent - Oui']) {
    const row=item();row.legs[0].selection.label.fr=label;cases.push(row);
  }
  for (const [kind,label] of [['match_winner','Victoire VfB Stuttgart'],['team_goals','Moins de 1,50 but pour VfB Stuttgart'],['draw','Match nul']]) {
    const row=item();row.legs[0].selection={betType:kind,label:{fr:label}};cases.push(row);
  }
  const worker=path.resolve(__dirname,'../tools/wintips-editorial-worker');
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c','import json,sys;from editorial_worker.sources import ticket_fingerprint;print(json.dumps([ticket_fingerprint(item) for item in json.load(sys.stdin)]))'],{cwd:worker,input:JSON.stringify(cases),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout),cases.map(t.ticketFingerprint));
});
test('protected config exposes current authoritative ticket state; ordinary category filtering stays unchanged',async()=>{
  const state={ready:true,...t.emptyState('2026-10-23')}; state.duo=t.entryFor(item());
  const service=createEditorialService({repository:{categories:async()=>[],ticketState:async day=>{assert.equal(day,state.editionDate);return state;}},clock:()=>new Date('2026-10-23T08:00:00Z')});
  const config=await service.workerConfig();assert.deepEqual(config.ticketState,state);assert.deepEqual(config.sources,[]);
});
module.exports={item};
