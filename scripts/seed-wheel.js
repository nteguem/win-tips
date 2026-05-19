// Seed initial pour la "Roue de la Chance" — V2 (tickets-based + multi-devises).
//
// Crée le singleton WheelConfig (avec ticketPacks) + 7 lots avec amounts
// multi-devises (XAF + CDF + XOF en défaut, l'admin ajustera).
//
// Idempotent : ne recrée pas les lots déjà présents (matching par name.fr).
// Si tu veux RECRÉER les lots à zéro, supprime-les d'abord depuis Mongo
// ou utilise le flag FORCE_RESEED=1.
//
// Lance avec :
//   $env:MONGO_URI='...' ; node scripts/seed-wheel.js
//   ou : MONGO_URI='...' node scripts/seed-wheel.js
//
// Pour repeupler de zéro :
//   $env:FORCE_RESEED='1' ; node scripts/seed-wheel.js

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
const FORCE = process.env.FORCE_RESEED === '1';

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
    enabled: !!VIP_PACKAGE_ID
  },
  {
    name: { fr: 'Cash niveau 1', en: 'Cash Tier 1' },
    type: 'cash',
    cash: {
      // Devises gérées : XAF & XOF (zones franc CFA — mêmes packages, parité 1:1)
      // + USD comme fallback universel pour tout autre pays.
      amounts: { XAF: 1000, XOF: 1000, USD: 2 },
      amount: 1000,
      currency: 'XAF'
    },
    color: '#4C8DFF',
    icon: '💵',
    order: 3,
    weight: 10,
    enabled: true,
    caps: { userDay: 2 }
  },
  {
    name: { fr: 'Cash niveau 2', en: 'Cash Tier 2' },
    type: 'cash',
    cash: {
      amounts: { XAF: 5000, XOF: 5000, USD: 10 },
      amount: 5000,
      currency: 'XAF'
    },
    color: '#FFB020',
    icon: '💰',
    order: 4,
    weight: 4,
    enabled: true,
    caps: { userDay: 1, globalDay: 5 }
  },
  {
    name: { fr: 'Jackpot Cash', en: 'Cash Jackpot' },
    type: 'cash',
    cash: {
      amounts: { XAF: 50000, XOF: 50000, USD: 100 },
      amount: 50000,
      currency: 'XAF'
    },
    color: '#FF5B5B',
    icon: '💎',
    order: 5,
    weight: 0,
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
    weight: 0,
    enabled: true,
    caps: { window: { days: 120, max: 1 } }
  }
];

async function run() {
  console.log('Connexion MongoDB...');
  await mongoose.connect(URI);
  console.log('Connecté à :', mongoose.connection.name);

  if (FORCE) {
    console.log('FORCE_RESEED=1 → suppression de tous les lots et reset config...');
    await WheelPrize.deleteMany({});
    await WheelConfig.deleteMany({});
  }

  // 1. Config singleton (les ticketPacks par défaut sont définis dans le schema)
  const cfg = await WheelConfig.getSingleton();
  console.log('WheelConfig :', {
    adsPerSpin: cfg.adsPerSpin,
    cooldownSec: cfg.cooldownSec,
    dailyMax: cfg.dailyMaxSpinsPerUser,
    enabled: cfg.wheelEnabled,
    ticketPacks: (cfg.ticketPacks || []).length + ' pack(s)'
  });
  (cfg.ticketPacks || []).forEach((p, i) => {
    console.log('  Pack #' + i + ': ' + p.tickets + ' tour(s) = ' + p.adsRequired + ' pubs (' + (p.label?.fr || '-') + ')' + (p.featured ? ' ★' : ''));
  });

  // 2. Lots
  let created = 0, skipped = 0;
  for (const data of PRIZES) {
    const existing = await WheelPrize.findOne({ 'name.fr': data.name.fr });
    if (existing) {
      console.log(`  [skip] "${data.name.fr}" (${existing._id})`);
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
  console.log('  1. Pour "Accès VIP 24h" : seed avec WHEEL_VIP_PACKAGE_ID=<packageId>.');
  console.log('  2. Activer "Jackpot Cash" et "iPhone 14" en mettant weight > 0 depuis l\'admin.');
  console.log('  3. Ajuster les amounts par devise dans le backoffice si besoin.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Erreur seed:', err);
  process.exit(1);
});
