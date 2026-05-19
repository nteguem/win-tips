// Seed initial pour la "Roue de la Chance".
//
// Crée le singleton WheelConfig + les 7 lots de base :
//   - Dommage (fallback)
//   - 1 Tour gratuit
//   - Accès VIP 24h
//   - 1 000 FCFA
//   - 5 000 FCFA
//   - 50 000 FCFA
//   - iPhone 14
//
// Idempotent : ne recrée pas les lots déjà présents (matching par name.fr).
//
// Lance avec :
//   $env:MONGO_URI='...' ; node scripts/seed-wheel.js
//
// Optionnel — si un packageId VIP existe pour le lot "Accès VIP 24h" :
//   $env:WHEEL_VIP_PACKAGE_ID='6532...'

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const WheelConfig = require(path.join(__dirname, '..', 'src', 'api', 'models', 'common', 'WheelConfig'));
const WheelPrize = require(path.join(__dirname, '..', 'src', 'api', 'models', 'common', 'WheelPrize'));

const URI = process.env.MONGO_URI;
if (!URI) {
  console.error('MONGO_URI manquant. Exporte-le ou met-le dans .env');
  process.exit(1);
}

const VIP_PACKAGE_ID = process.env.WHEEL_VIP_PACKAGE_ID || null;

const PRIZES = [
  {
    name: { fr: 'Dommage', en: 'Try again' },
    type: 'none',
    color: '#5C6470',
    icon: '😐',
    order: 0,
    weight: 30,
    enabled: true,
    isFallback: true
  },
  {
    name: { fr: '1 Tour gratuit', en: '1 Free spin' },
    type: 'free_spin',
    freeSpin: { count: 1 },
    color: '#1FC36B',
    icon: '🎁',
    order: 1,
    weight: 35,
    enabled: true
  },
  {
    name: { fr: 'Accès VIP 24h', en: 'VIP access 24h' },
    type: 'subscription',
    subscription: { packageId: VIP_PACKAGE_ID, durationHours: 24 },
    color: '#D4A017',
    icon: '👑',
    order: 2,
    weight: 20,
    enabled: !!VIP_PACKAGE_ID  // désactivé tant que packageId n'est pas configuré
  },
  {
    name: { fr: '1 000 FCFA', en: '1,000 FCFA' },
    type: 'cash',
    cash: { amount: 1000, currency: 'XAF' },
    color: '#4C8DFF',
    icon: '💵',
    order: 3,
    weight: 10,
    enabled: true,
    caps: { userDay: 2 }
  },
  {
    name: { fr: '5 000 FCFA', en: '5,000 FCFA' },
    type: 'cash',
    cash: { amount: 5000, currency: 'XAF' },
    color: '#FFB020',
    icon: '💰',
    order: 4,
    weight: 4,
    enabled: true,
    caps: { userDay: 1, globalDay: 5 }
  },
  {
    name: { fr: '50 000 FCFA', en: '50,000 FCFA' },
    type: 'cash',
    cash: { amount: 50000, currency: 'XAF' },
    color: '#FF5B5B',
    icon: '💎',
    order: 5,
    weight: 0,  // désactivé par défaut côté tirage (mais visible sur la roue)
    enabled: true,
    caps: { globalDay: 1, userMonth: 1 }
  },
  {
    name: { fr: 'iPhone 14', en: 'iPhone 14' },
    type: 'physical',
    physical: { label: 'iPhone 14', notes: 'Livraison logistique manuelle' },
    color: '#0A7A46',
    icon: '📱',
    order: 6,
    weight: 0,  // désactivé par défaut — l'admin active quand prêt
    enabled: true,
    caps: { window: { days: 120, max: 1 } }
  }
];

async function run() {
  console.log('Connexion MongoDB...');
  await mongoose.connect(URI);
  console.log('Connecté.');

  // 1. Config singleton
  const cfg = await WheelConfig.getSingleton();
  console.log(`WheelConfig: adsPerSpin=${cfg.adsPerSpin}, enabled=${cfg.wheelEnabled}, dailyMax=${cfg.dailyMaxSpinsPerUser}`);

  // 2. Lots (idempotent)
  let created = 0;
  let skipped = 0;
  for (const data of PRIZES) {
    const existing = await WheelPrize.findOne({ 'name.fr': data.name.fr });
    if (existing) {
      console.log(`  [skip] "${data.name.fr}" existe déjà (${existing._id})`);
      skipped++;
      continue;
    }
    if (data.isFallback) {
      await WheelPrize.updateMany({ isFallback: true }, { $set: { isFallback: false } });
    }
    const p = await WheelPrize.create(data);
    console.log(`  [+]    "${p.name.fr}" créé (${p._id})`);
    created++;
  }

  console.log(`\nFini. ${created} lot(s) créé(s), ${skipped} déjà présent(s).`);
  console.log('\nProchaines étapes :');
  console.log('  1. Depuis le backoffice, configure les probabilités et les caps selon ta stratégie.');
  console.log('  2. Pour le lot "Accès VIP 24h", relance avec WHEEL_VIP_PACKAGE_ID=<packageId>.');
  console.log('  3. Active les lots "50 000 FCFA" et "iPhone 14" en mettant weight > 0 depuis l\'admin.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Erreur seed:', err);
  process.exit(1);
});
