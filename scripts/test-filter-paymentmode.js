// Test direct du filtre paymentMode en interrogeant Mongoose, sans passer
// par l'API. Si ça filtre correctement ici, on est sûrs que le code va
// bien filtrer en prod aussi (à condition que le bon Node soit lancé).

require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const Package = require(path.join(__dirname, '..', 'src', 'api', 'models', 'common', 'Package'));

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[main] connecté DB\n');

  for (const mode of ['money', 'ads']) {
    const filter = { isActive: true };
    if (mode === 'money') {
      filter.paymentMode = { $in: ['money', null] };
    } else if (mode === 'ads') {
      filter.paymentMode = 'ads';
    }

    console.log(`━━━ Test filter paymentMode=${mode} ━━━`);
    console.log('Filter Mongoose:', JSON.stringify(filter));
    const packs = await Package.find(filter).lean();
    console.log(`Résultat: ${packs.length} pack(s)\n`);
    for (const p of packs) {
      const nm = p.name?.fr || p.name?.en || p.name || '?';
      console.log(`  - _id=${p._id}`);
      console.log(`    paymentMode=${p.paymentMode} | adsRequired=${p.adsRequired} | name=${nm}`);
      console.log(`    pricing.XAF=${p.pricing?.XAF || p.pricing?.get?.('XAF') || 'none'}`);
    }
    console.log('');
  }

  // Aussi : afficher TOUS les packs (sans filtre) pour voir la donnée brute
  console.log('━━━ TOUS les packs (sans filtre) ━━━');
  const all = await Package.find({}).lean();
  console.log(`Total: ${all.length} pack(s)`);
  for (const p of all) {
    const nm = p.name?.fr || p.name?.en || p.name || '?';
    console.log(`  - paymentMode=${JSON.stringify(p.paymentMode)} | isActive=${p.isActive} | name=${nm}`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
