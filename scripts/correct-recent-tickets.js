/**
 * @fileoverview Correction manuelle des N derniers tickets free + N derniers
 * tickets VIP (à lancer quand le cron de correction n'a pas tourné).
 *
 * Pour chaque ticket : corrige les pronostics encore 'pending' via le moteur
 * Corrector (mêmes appels API sportives que le cron), puis recalcule le
 * résultat consolidé du ticket (won / lost / pending / void).
 *
 * Utilisation : node scripts/correct-recent-tickets.js [N]
 *   N : nombre de tickets free + VIP à corriger (défaut 10).
 *
 * Variables d'env requises : celles du .env de l'API (MONGO_URI + clés des
 * providers sportifs). Le script ne fonctionne que sur un serveur où ces
 * variables sont définies — typiquement directement sur la prod.
 */
require('dotenv').config();
const mongoose = require('mongoose');

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI manquant dans l'environnement.");
  process.exit(1);
}

const Ticket = require('../src/api/models/common/Ticket');
const Category = require('../src/api/models/common/Category');
const { correctTicket } = require('../src/api/services/admin/correctAndNotifyService');

const N = parseInt(process.argv[2], 10) || 10;

const LABEL = {
  won: '✅ gagné',
  lost: '❌ perdu',
  pending: '⏳ en attente',
  void: '⚪ annulé',
};

/** Corrige une liste de tickets et affiche le résultat de chacun. */
async function processTickets(label, tickets) {
  console.log(`\n=== ${label} (${tickets.length} ticket${tickets.length > 1 ? 's' : ''}) ===`);
  if (tickets.length === 0) {
    console.log('  (aucun ticket trouvé)');
    return;
  }
  for (const t of tickets) {
    const date = new Date(t.date).toISOString().slice(0, 10);
    try {
      const res = await correctTicket(t._id);
      const r = LABEL[res.result] || res.result;
      const p = res.predictions;
      console.log(
        `  ${date}  ${t._id}  →  ${r}  (${p.corrected}/${p.total} corrigés, ${p.stillPending} pending, ${p.errors} erreurs)`
      );
    } catch (e) {
      console.log(`  ${date}  ${t._id}  →  ❌ ERREUR : ${e.message}`);
    }
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`✅ Connecté à MongoDB (base : ${mongoose.connection.name})\n`);

  // Récupère les ids de catégories par tier (free vs VIP).
  const [freeCats, vipCats] = await Promise.all([
    Category.find({ isVip: false }).select('_id').lean(),
    Category.find({ isVip: true }).select('_id').lean(),
  ]);
  const freeIds = freeCats.map((c) => c._id);
  const vipIds = vipCats.map((c) => c._id);

  // Récupère les N derniers tickets de chaque tier, triés par date décroissante.
  const [freeTickets, vipTickets] = await Promise.all([
    Ticket.find({ category: { $in: freeIds } })
      .sort({ date: -1 })
      .limit(N)
      .lean(),
    Ticket.find({ category: { $in: vipIds } })
      .sort({ date: -1 })
      .limit(N)
      .lean(),
  ]);

  await processTickets(`FREE — ${N} derniers tickets`, freeTickets);
  await processTickets(`VIP  — ${N} derniers tickets`, vipTickets);

  console.log('\n✅ Correction terminée.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('❌ Erreur :', e);
  process.exit(1);
});
