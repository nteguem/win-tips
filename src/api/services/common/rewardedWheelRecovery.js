'use strict';
const crypto = require('node:crypto');

// Mongo standalone-safe: nonce receipt and balance are updated in ONE stats
// document. The subsequent unlock reset may be retried after any crash.
function createRecovery({ UserAccessUnlock: Unlock, WheelConfig: Config, WheelUserStats: Stats,
    AppError, ErrorCodes, multiTenant }) {
  const scope = (app, user) => multiTenant ? { appId: app, user } : { user };
  const config = app => multiTenant ? Config.getSingleton(app) : Config.getSingleton();
  const unavailable = message => new AppError(message, 503, ErrorCodes.SERVICE_UNAVAILABLE);
  async function start(app, user, packIndex) {
    const cfg = await config(app), idx = Number(packIndex);
    if (!cfg.wheelEnabled) throw unavailable('La roue est temporairement indisponible.');
    if (!Number.isInteger(idx) || idx < 0 || idx >= (cfg.ticketPacks || []).length)
      throw new AppError('Pack de tours invalide.', 400, ErrorCodes.VALIDATION_ERROR);
    const pack = cfg.ticketPacks[idx];
    const identity = { ...scope(app, user), resourceType: 'wheel_tickets', resource: cfg._id };
    let doc = await Unlock.findOne(identity);
    if (doc?.nonce && doc.status === 'unlocked') return state(app, user, doc.nonce);
    if (doc?.nonce && doc.status === 'in_progress') {
      if (!doc.nonce.startsWith(`idx${idx}-`)) throw new AppError(
        'Un pack est en cours de validation. Actualise sa progression avant de changer.', 409, ErrorCodes.OPERATION_NOT_ALLOWED);
      return { nonce: doc.nonce, adsRequired: doc.selectedOption.adsRequired,
        adsWatched: doc.verifiedCount || 0, verifiedCount: doc.verifiedCount || 0, completed: false,
        ticketsToCredit: doc.selectedOption.ticketsToCredit || pack.tickets, packIndex: idx,
        packLabel: pack.label?.fr || `${pack.tickets} tour(s)`, resumed: true };
    }
    const fields = { status: 'in_progress', verifiedCount: 0, rewards: [], unlockedAt: null, expiresAt: null,
      selectedOption: { adsRequired: pack.adsRequired, durationMinutes: null, ticketsToCredit: pack.tickets },
      nonce: `idx${idx}-${crypto.randomBytes(20).toString('hex')}` };
    if (doc) {
      const changed = await Unlock.findOneAndUpdate({ _id: doc._id, nonce: doc.nonce }, { $set: fields }, { new: true });
      if (!changed) return start(app, user, idx);
      doc = changed;
    } else {
      try { doc = await Unlock.create({ ...identity, ...fields }); }
      catch (err) { if (err.code === 11000) return start(app, user, idx); throw err; }
    }
    return { nonce: doc.nonce, adsRequired: pack.adsRequired, adsWatched: 0, verifiedCount: 0,
      completed: false, ticketsToCredit: pack.tickets, packIndex: idx,
      packLabel: pack.label?.fr || `${pack.tickets} tour(s)`, resumed: false };
  }
  async function state(app, user, requestedNonce = null) {
    const cfg = await config(app), identity = scope(app, user);
    if (multiTenant) await Stats.getOrCreate(app, user); else await Stats.getOrCreate(user);
    let stats = await Stats.findOne(identity).select('+rewardedCredits');
    const doc = await Unlock.findOne({ ...identity, resourceType: 'wheel_tickets', resource: cfg._id });
    const acknowledged = typeof requestedNonce === 'string' && requestedNonce.length <= 160
      ? (stats.rewardedCredits || []).find(row => row.nonce === requestedNonce) : null;
    if (acknowledged && !(doc?.nonce === requestedNonce && doc.status === 'unlocked'))
      return { hasActiveUnlock: false, completed: true, nonce: requestedNonce,
        creditedNonce: requestedNonce, creditedTickets: acknowledged.tickets, justCredited: 0,
        ticketsToCredit: acknowledged.tickets, ticketsBalance: stats.ticketsBalance,
        adsRequired: 0, adsWatched: 0, verifiedCount: 0 };
    if (!doc?.nonce) return { hasActiveUnlock: false, completed: false, nonce: null,
      adsRequired: 0, adsWatched: 0, verifiedCount: 0, ticketsBalance: stats.ticketsBalance, justCredited: 0,
      creditedNonce: stats.lastRewardedNonce || null, creditedTickets: stats.lastRewardedTickets || 0 };
    const nonce = doc.nonce, adsRequired = doc.selectedOption?.adsRequired || 0;
    if (doc.status === 'unlocked') {
      const match = /^idx(\d+)-/.exec(nonce), pack = match && (cfg.ticketPacks || [])[Number(match[1])];
      const tickets = doc.selectedOption?.ticketsToCredit || pack?.tickets;
      if (!Number.isInteger(tickets) || tickets < 1) throw unavailable('Pack validé en attente de configuration. Réessaie plus tard.');
      const credited = await Stats.findOneAndUpdate({ ...identity, 'rewardedCredits.nonce': { $ne: nonce } }, {
        $inc: { ticketsBalance: tickets, totalTicketsEarned: tickets },
        $push: { rewardedCredits: { nonce, tickets, creditedAt: new Date() } },
        $set: { lastRewardedNonce: nonce, lastRewardedTickets: tickets }
      }, { new: true });
      stats = credited || await Stats.findOne(identity);
      // Crash before this reset: the marker survives, so a new worker/poll only
      // completes the reset. An older poll cannot reset a newer session.
      await Unlock.updateOne({ _id: doc._id, nonce, status: 'unlocked' }, { $set: {
        status: 'in_progress', verifiedCount: 0, rewards: [], unlockedAt: null, expiresAt: null,
        nonce: null, selectedOption: { adsRequired: null, durationMinutes: null, ticketsToCredit: null }
      } });
      return { hasActiveUnlock: false, adsRequired, adsWatched: adsRequired, verifiedCount: adsRequired,
        completed: true, nonce, creditedNonce: nonce, creditedTickets: tickets, ticketsToCredit: tickets,
        ticketsBalance: stats.ticketsBalance, justCredited: credited ? tickets : 0 };
    }
    return { hasActiveUnlock: true, adsRequired,
      adsWatched: Math.min(doc.verifiedCount || 0, adsRequired || Number.MAX_SAFE_INTEGER),
      verifiedCount: doc.verifiedCount || 0, completed: false, nonce,
      ticketsBalance: stats.ticketsBalance, justCredited: 0,
      creditedNonce: stats.lastRewardedNonce || null, creditedTickets: stats.lastRewardedTickets || 0 };
  }
  return multiTenant ? { startUnlock: start, getUnlockState: state } : {
    startUnlock: (user, idx) => start(null, user, idx),
    getUnlockState: (user, nonce) => state(null, user, nonce),
  };
}
module.exports = { createRecovery };
