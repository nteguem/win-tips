// Audit direct sur la DB PROD pour vérifier :
//  1. Quels packs ont paymentMode='ads' ?
//  2. Quels packs ont paymentMode='money' ?
//  3. Le filter Mongoose retourne-t-il les bons packs depuis cette DB ?
//
// Si le filter retourne les bons packs ici (connecté à la même DB que prod),
// alors le bug "Postman renvoie 3 packs au lieu de 1" n'est PAS dans le code
// mais dans le déploiement (PM2 lance un ancien code, ou nginx cache, etc.)

const mongoose = require('mongoose');
const path = require('path');
const Package = require(path.join(__dirname, '..', 'src', 'api', 'models', 'common', 'Package'));

const PROD_URI = 'mongodb+srv://roland:Biggismall54321@cluster-bigwin.alyah.mongodb.net/wintips?retryWrites=true&w=majority';

(async () => {
  await mongoose.connect(PROD_URI);
  console.log('[audit-prod] connecté à DB prod\n');

  console.log('━━━━━━━ TOUS les packs en DB prod ━━━━━━━');
  const all = await Package.find({}).lean();
  console.log(`Total: ${all.length} packs\n`);
  for (const p of all) {
    const nm = p.name?.fr || p.name?.en || p.name || '?';
    console.log(`  _id=${p._id}`);
    console.log(`    name=${nm}`);
    console.log(`    paymentMode=${JSON.stringify(p.paymentMode)}`);
    console.log(`    adsRequired=${p.adsRequired}`);
    console.log(`    isActive=${p.isActive}`);
    console.log('');
  }

  console.log('━━━━━━━ Test filter paymentMode=ads (comme le controller) ━━━━━━━');
  const filterAds = { isActive: true, paymentMode: 'ads' };
  console.log('Filter:', JSON.stringify(filterAds));
  const adsPacks = await Package.find(filterAds).lean();
  console.log(`Résultat: ${adsPacks.length} pack(s)`);
  for (const p of adsPacks) {
    const nm = p.name?.fr || p.name?.en || p.name || '?';
    console.log(`  - ${nm} (paymentMode=${p.paymentMode}, adsRequired=${p.adsRequired})`);
  }
  console.log('');

  console.log('━━━━━━━ Test filter paymentMode=money (comme le controller) ━━━━━━━');
  const filterMoney = { isActive: true, paymentMode: { $in: ['money', null] } };
  console.log('Filter:', JSON.stringify(filterMoney));
  const moneyPacks = await Package.find(filterMoney).lean();
  console.log(`Résultat: ${moneyPacks.length} pack(s)`);
  for (const p of moneyPacks) {
    const nm = p.name?.fr || p.name?.en || p.name || '?';
    console.log(`  - ${nm} (paymentMode=${p.paymentMode || 'UNDEFINED'})`);
  }
  console.log('');

  await mongoose.disconnect();
  console.log('[audit-prod] terminé');
})().catch(e => { console.error(e); process.exit(1); });
