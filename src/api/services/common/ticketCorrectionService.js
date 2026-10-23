/**
 * @fileoverview Correction des tickets (coupons) à partir du résultat de
 * leurs prédictions.
 *
 * Règle métier :
 *   - won     : toutes les prédictions décidées sont 'won' (au moins 1 décidée)
 *   - lost    : au moins 1 prédiction 'lost'
 *   - pending : il reste des prédictions 'pending' et aucune 'lost'
 *   - void    : uniquement des 'void' (cas marginal)
 *
 * Doit s'exécuter APRÈS la correction des prédictions.
 */
const logger = require('../../../utils/logger');
const Ticket = require('../../models/common/Ticket');
const Prediction = require('../../models/common/Prediction');

/** Dérive le résultat d'un ticket à partir des statuts de ses prédictions. */
function deriveResult(predStatuses) {
  let pending = 0;
  let won = 0;
  let lost = 0;
  let voidCount = 0;
  for (const s of predStatuses) {
    if (s === 'pending') pending++;
    else if (s === 'won') won++;
    else if (s === 'lost') lost++;
    else if (s === 'void') voidCount++;
  }
  if (lost > 0) return 'lost';
  if (pending > 0) return 'pending';
  if (won > 0) return 'won';
  if (voidCount > 0) return 'void';
  return 'pending';
}

/**
 * Recalcule le résultat des tickets dans la fenêtre lookback (ou ceux
 * explicitement ciblés via `ticketIds`).
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.lookbackDays=10] - Fenêtre en jours (ignorée si ticketIds fourni)
 * @param {boolean} [opts.dryRun=false]    - Ne rien écrire en base
 * @param {Array}   [opts.ticketIds]       - Cibler des tickets précis
 * @returns {Promise<Object>} Statistiques { scanned, updated, byResult, durationMs }
 */
async function correctTickets({ lookbackDays = 10, dryRun = false, ticketIds } = {}) {
  const startTime = Date.now();

  const ticketQuery = {};
  if (Array.isArray(ticketIds) && ticketIds.length > 0) {
    ticketQuery._id = { $in: ticketIds };
  } else {
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);
    ticketQuery.createdAt = { $gte: since };
  }

  const tickets = await Ticket.find(ticketQuery).select('_id result').lean();
  if (tickets.length === 0) {
    return { scanned: 0, updated: 0, byResult: {}, durationMs: Date.now() - startTime };
  }

  const ids = tickets.map((t) => t._id);
  const preds = await Prediction.find({ ticket: { $in: ids } })
    .select('ticket status')
    .lean();

  // Indexer les statuts de prédictions par ticket.
  const predsByTicket = new Map();
  for (const p of preds) {
    const key = String(p.ticket);
    if (!predsByTicket.has(key)) predsByTicket.set(key, []);
    predsByTicket.get(key).push(p.status);
  }

  const stats = {
    scanned: tickets.length,
    updated: 0,
    byResult: { pending: 0, won: 0, lost: 0, void: 0 },
  };
  const bulkOps = [];

  for (const t of tickets) {
    const statuses = predsByTicket.get(String(t._id)) || [];
    // Aucun pronostic ⇒ on laisse 'pending' (ticket brouillon probable).
    if (statuses.length === 0) continue;

    const newResult = deriveResult(statuses);
    stats.byResult[newResult] = (stats.byResult[newResult] || 0) + 1;

    if (t.result !== newResult) {
      stats.updated++;
      if (!dryRun) {
        bulkOps.push({
          updateOne: {
            filter: { _id: t._id },
            update: { $set: { result: newResult, resultUpdatedAt: new Date() } },
          },
        });
      }
    }
  }

  if (bulkOps.length > 0 && !dryRun) {
    await Ticket.bulkWrite(bulkOps, { ordered: false });
  }

  stats.durationMs = Date.now() - startTime;
  logger.info(
    `[ticketCorrection] scanned=${stats.scanned} updated=${stats.updated} ` +
      `won=${stats.byResult.won} lost=${stats.byResult.lost} ` +
      `pending=${stats.byResult.pending} void=${stats.byResult.void}`
  );

  return stats;
}

module.exports = { correctTickets, deriveResult };
