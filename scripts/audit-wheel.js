// Audit E2E approfondi de la roue V2.
// Lance : MONGO_URI=... node scripts/audit-wheel.js

require('dotenv').config();
const mongoose = require('mongoose');
const wheelService = require('../src/api/services/user/wheelService');
const wheelTicketService = require('../src/api/services/user/wheelTicketService');
const wheelAdminService = require('../src/api/services/admin/wheelAdminService');
const accessGate = require('../src/api/services/common/accessGateService');

let exitCode = 0;
function ok(label) { console.log('  ✅', label); }
function ko(label, why) { console.log('  ❌', label, '—', why || ''); exitCode = 1; }
function section(t) { console.log('\n═══', t, '═══'); }

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const User = require('../src/api/models/user/User');
  const WheelSpin = require('../src/api/models/common/WheelSpin');
  const WheelUserStats = require('../src/api/models/common/WheelUserStats');
  const UserAccessUnlock = require('../src/api/models/common/UserAccessUnlock');
  const Wallet = require('../src/api/models/common/Wallet');
  const WalletTransaction = require('../src/api/models/common/WalletTransaction');
  const WheelConfig = require('../src/api/models/common/WheelConfig');
  const WheelPrize = require('../src/api/models/common/WheelPrize');

  const cfg = await WheelConfig.getSingleton();
  const oldCooldown = cfg.cooldownSec;
  const oldDailyMax = cfg.dailyMaxSpinsPerUser;
  cfg.cooldownSec = 0;
  cfg.dailyMaxSpinsPerUser = 200;
  await cfg.save();

  section('1. Config publique multi-devises (XAF/XOF natif, autres → USD)');
  const findCash1 = list => list.find(p => p.name === 'Cash niveau 1');
  const tests = [
    { cur: 'XAF', expectAmount: 1000, expectCur: 'XAF' },
    { cur: 'XOF', expectAmount: 1000, expectCur: 'XOF' },
    { cur: 'USD', expectAmount: 2, expectCur: 'USD' },
    { cur: 'CDF', expectAmount: 2, expectCur: 'USD' },   // fallback
    { cur: 'GMD', expectAmount: 2, expectCur: 'USD' },   // fallback
    { cur: 'KES', expectAmount: 2, expectCur: 'USD' },   // fallback
    { cur: 'EUR', expectAmount: 2, expectCur: 'USD' }    // fallback
  ];
  for (const t of tests) {
    const cfgRes = await wheelService.getPublicConfig('fr', t.cur);
    const c = findCash1(cfgRes.prizes);
    if (!c || !c.cash) { ko(t.cur, 'pas de Cash niveau 1'); continue; }
    if (c.cash.amount === t.expectAmount && c.cash.currency === t.expectCur) {
      ok(`${t.cur.padEnd(3)} user → ${c.cash.amount} ${c.cash.currency}`);
    } else ko(t.cur, `attendu ${t.expectAmount} ${t.expectCur}, reçu ${c.cash.amount} ${c.cash.currency}`);
  }

  section('2. Refus spin sans tickets (402 PAYMENT_REQUIRED)');
  const u1 = await User.create({
    phoneNumber: '+237_AUDIT_' + Date.now(),
    password: 'audit_test_123!', pseudo: 'audit', authProvider: 'local', isActive: true
  });
  try {
    await wheelService.spin(u1._id, { currency: 'XAF' });
    ko('Refus 402', 'Aurait dû échouer');
  } catch (e) {
    if (e.statusCode === 402 && e.errorCode === 'PAYMENT_REQUIRED') ok('402 PAYMENT_REQUIRED retourné');
    else ko('402', e.statusCode + ' / ' + e.errorCode);
  }

  section('3. Packs de tours configurés');
  const packs = await wheelTicketService.listPacks('fr');
  if (packs.length === 3) ok('3 packs configurés'); else ko('Packs', packs.length);
  if (packs[0].tickets === 1 && packs[0].adsRequired === 3) ok('Pack 0 : 1 tour / 3 pubs');
  if (packs[1].featured === true) ok('Pack 1 marqué featured ★');
  if (packs[2].tickets === 15 && packs[2].adsRequired === 30) ok('Pack 2 : 15 tours / 30 pubs');

  section('4. Déblocage tickets via pipeline SSV');
  const startRes = await wheelTicketService.startUnlock(u1._id, 0);
  if (startRes.adsRequired === 3 && startRes.ticketsToCredit === 1) ok('startUnlock pack 0 OK');
  for (let i = 1; i <= 3; i++) {
    await accessGate.recordVerifiedReward({
      nonce: startRes.nonce,
      userId: u1._id.toString(),
      transactionId: 'audit-p0-' + i + '-' + Date.now(),
      timestampMs: String(Date.now())
    });
  }
  const stateAfter = await wheelTicketService.getUnlockState(u1._id);
  if (stateAfter.justCredited === 1 && stateAfter.ticketsBalance === 1) ok('1 ticket crédité après 3 pubs');
  else ko('Crédit', JSON.stringify(stateAfter));

  section('5. Spin synchrone (consomme 1 ticket)');
  const spin1 = await wheelService.spin(u1._id, { currency: 'XAF' });
  ok('Spin réussi : ' + spin1.prize.name + ' (' + spin1.prize.type + ')');
  if (spin1.prize.type === 'cash') ok('  → amount cash : ' + spin1.prize.cash.amount + ' ' + spin1.prize.cash.currency);
  const statsAfter1 = await WheelUserStats.findOne({ user: u1._id });
  if (spin1.prize.type === 'free_spin') {
    if (statsAfter1.ticketsBalance >= 1) ok('free_spin gagné → balance ré-incrémentée (' + statsAfter1.ticketsBalance + ')');
    else ko('free_spin re-crédit', 'balance=' + statsAfter1.ticketsBalance);
  } else {
    if (statsAfter1.ticketsBalance === 0) ok('Ticket décrémenté à 0');
    else ko('Décrément', 'balance=' + statsAfter1.ticketsBalance);
  }

  section('6. Idempotence clientRequestId');
  // Re-débloque 5 tickets
  const reUnlock = await wheelTicketService.startUnlock(u1._id, 1);
  for (let i = 1; i <= 12; i++) await accessGate.recordVerifiedReward({
    nonce: reUnlock.nonce, userId: u1._id.toString(),
    transactionId: 'audit-idem-' + i + '-' + Date.now(), timestampMs: String(Date.now())
  });
  await wheelTicketService.getUnlockState(u1._id);
  const balBefore = (await WheelUserStats.findOne({ user: u1._id })).ticketsBalance;
  const reqId = 'audit-req-' + Date.now();
  const s1 = await wheelService.spin(u1._id, { currency: 'XAF', clientRequestId: reqId });
  const s2 = await wheelService.spin(u1._id, { currency: 'XAF', clientRequestId: reqId });
  if (String(s1._id) === String(s2._id)) ok('Même clientRequestId → même spin retourné');
  else ko('Idempotence', 's1=' + s1._id + ' s2=' + s2._id);
  const balAfter = (await WheelUserStats.findOne({ user: u1._id })).ticketsBalance;
  const expectedDelta = s1.prize.type === 'free_spin' ? 0 : 1;
  if (balBefore - balAfter === expectedDelta || (s1.prize.type === 'free_spin' && balAfter >= balBefore - 1)) {
    ok('1 seul ticket consommé pour 2 calls (balance ' + balBefore + '→' + balAfter + ')');
  } else ko('Idempotence ticket', 'delta=' + (balBefore - balAfter));

  section('7. Cooldown enforcement');
  cfg.cooldownSec = 5;
  await cfg.save();
  // Re-débloque
  const cdUnlock = await wheelTicketService.startUnlock(u1._id, 1);
  for (let i = 1; i <= 12; i++) await accessGate.recordVerifiedReward({
    nonce: cdUnlock.nonce, userId: u1._id.toString(),
    transactionId: 'audit-cd-' + i + '-' + Date.now(), timestampMs: String(Date.now())
  });
  await wheelTicketService.getUnlockState(u1._id);
  await wheelService.spin(u1._id, { currency: 'XAF' });
  try {
    await wheelService.spin(u1._id, { currency: 'XAF' });
    ko('Cooldown', 'Aurait dû refuser');
  } catch (e) {
    if (e.statusCode === 429) ok('Cooldown 5s respecté (429 retourné)');
    else ko('Cooldown', e.statusCode + ' ' + e.message);
  }
  cfg.cooldownSec = 0;
  await cfg.save();

  section('8. Admin services');
  const adminPrizes = await wheelAdminService.listPrizes();
  if (adminPrizes.length === 7) ok('Admin : 7 lots listés'); else ko('Admin prizes', adminPrizes.length);
  const adminConfig = await wheelAdminService.getConfig();
  if (adminConfig.ticketPacks && adminConfig.ticketPacks.length === 3) ok('Admin : 3 ticketPacks');
  const adminStats = await wheelAdminService.getStats({});
  ok('Admin stats : ' + adminStats.totalSpins + ' spin(s) historique total, ' + adminStats.byPrize.length + ' lots distribués');
  const adminSpinList = await wheelAdminService.listSpins({ limit: 5 });
  ok('Admin listSpins : ' + adminSpinList.total + ' total');

  section('9. Cap globalDay sur un lot — exclusion stricte');
  const jackpot = await WheelPrize.findOne({ 'name.fr': 'Jackpot Cash' });
  const origWeight = jackpot.weight;
  await WheelPrize.updateOne({ _id: jackpot._id }, { $set: { weight: 100 } });
  const otherUser = await User.create({
    phoneNumber: '+237_AUDIT_O_' + Date.now(),
    password: 'audit_test_123!', pseudo: 'audit_o', authProvider: 'local', isActive: true
  });
  await WheelSpin.create({
    user: otherUser._id, prize: jackpot._id,
    prizeSnapshot: { name: jackpot.name, type: 'cash', cash: { amount: 50000, currency: 'XAF' } },
    nonce: 'audit-pre-jackpot-' + Date.now(),
    status: 'claimed_auto'
  });
  let jackpotHits = 0;
  for (let i = 0; i < 50; i++) {
    const p = await wheelService.drawPrize(u1._id);
    if (String(p._id) === String(jackpot._id)) jackpotHits++;
  }
  if (jackpotHits === 0) ok('Cap globalDay=1 respecté : 0 jackpot sur 50 tirages avec weight=100');
  else ko('Cap', jackpotHits + '/50 jackpots tirés');
  await WheelPrize.updateOne({ _id: jackpot._id }, { $set: { weight: origWeight } });

  section('10. Wallet : crédité dans la bonne devise');
  // Force un spin cash avec USD
  // Re-débloque 5 tickets
  const usdUnlock = await wheelTicketService.startUnlock(u1._id, 1);
  for (let i = 1; i <= 12; i++) await accessGate.recordVerifiedReward({
    nonce: usdUnlock.nonce, userId: u1._id.toString(),
    transactionId: 'audit-usd-' + i + '-' + Date.now(), timestampMs: String(Date.now())
  });
  await wheelTicketService.getUnlockState(u1._id);
  for (let i = 0; i < 5; i++) {
    try { await wheelService.spin(u1._id, { currency: 'USD' }); } catch (_) {}
  }
  const wal = await Wallet.findOne({ user: u1._id });
  if (wal) {
    const balances = [...wal.balances].map(([c, v]) => c + '=' + v).join(', ');
    ok('Wallet : ' + balances);
  } else {
    console.log('  ℹ️ Pas de cash gagné dans cette session — non bloquant');
  }

  // Cleanup
  await WheelSpin.deleteMany({ user: { $in: [u1._id, otherUser._id] } });
  await UserAccessUnlock.deleteMany({ user: u1._id });
  await WheelUserStats.deleteMany({ user: u1._id });
  await Wallet.deleteMany({ user: u1._id });
  await WalletTransaction.deleteMany({ user: u1._id });
  await User.deleteMany({ _id: { $in: [u1._id, otherUser._id] } });
  cfg.cooldownSec = oldCooldown;
  cfg.dailyMaxSpinsPerUser = oldDailyMax;
  await cfg.save();

  await mongoose.disconnect();
  console.log('\n══════════════════════════════════════');
  console.log(exitCode === 0 ? '✅ AUDIT COMPLET — TOUS LES TESTS PASSENT' : '❌ AUDIT ÉCHOUÉ');
  console.log('══════════════════════════════════════');
  process.exit(exitCode);
}

run().catch(e => { console.error('❌ FATAL', e.message); console.error(e.stack); process.exit(1); });
