/**
 * @fileoverview Statistiques de résultats des pronostics et des coupons.
 * Alimente la modal « bilan » du tableau de bord.
 */
const Prediction = require('../../models/common/Prediction');
const Ticket = require('../../models/common/Ticket');

/** Taux de réussite (%) arrondi à 1 décimale : gagnés / (gagnés + perdus). */
function winRate(won, lost) {
  const decided = won + lost;
  return decided > 0 ? Math.round((won / decided) * 1000) / 10 : 0;
}

/** Stats des pronostics (Prediction.status) créés depuis `since`. */
async function getPredictionStats(since) {
  const agg = await Prediction.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const c = { won: 0, lost: 0, pending: 0, void: 0 };
  for (const r of agg) {
    if (c[r._id] !== undefined) c[r._id] = r.count;
  }
  return {
    won: c.won,
    lost: c.lost,
    pending: c.pending,
    decided: c.won + c.lost,
    successRate: winRate(c.won, c.lost),
  };
}

/** Stats des coupons (Ticket.result) créés depuis `since`. */
async function getTicketStats(since) {
  const agg = await Ticket.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$result', count: { $sum: 1 } } },
  ]);
  const c = { won: 0, lost: 0, pending: 0, void: 0 };
  for (const r of agg) {
    if (c[r._id] !== undefined) c[r._id] = r.count;
  }
  return {
    won: c.won,
    lost: c.lost,
    pending: c.pending,
    decided: c.won + c.lost,
    successRate: winRate(c.won, c.lost),
  };
}

/**
 * Mini-bilan pour la modal du dashboard : fenêtre 10 jours, avec repli
 * automatique sur 30 jours si moins de 5 coupons ont été décidés.
 */
async function getDashboardMini() {
  const now = Date.now();
  const since10 = new Date(now - 10 * 24 * 3600 * 1000);

  let period = '10d';
  let predictions = await getPredictionStats(since10);
  let tickets = await getTicketStats(since10);

  if (tickets.decided < 5) {
    period = 'month';
    const since30 = new Date(now - 30 * 24 * 3600 * 1000);
    predictions = await getPredictionStats(since30);
    tickets = await getTicketStats(since30);
  }

  return { period, predictions, tickets };
}

module.exports = { getDashboardMini, getPredictionStats, getTicketStats };
