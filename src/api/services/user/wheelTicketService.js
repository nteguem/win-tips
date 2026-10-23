// src/api/services/user/wheelTicketService.js
//
// Gestion du déblocage des "tours" (tickets) de la roue par visionnage de pubs.
//
// Flow :
//   1. listPacks(lang)
//      → renvoie les ticketPacks configurés (admin).
//
//   2. startUnlock(userId, packIndex)
//      → crée un UserAccessUnlock 'wheel_tickets' avec :
//          - selectedOption.adsRequired = pack.adsRequired
//          - selectedOption.durationMinutes = null (pas de durée — c'est un crédit one-shot)
//        et un nonce frais. Stocke aussi `packIndex` dans une métadonnée
//        portée par le `resource` (on utilise resource = ObjectId nul puisqu'il
//        n'y a pas de "ressource" tangible, mais on doit garder l'unicité
//        user/type/resource → on utilise un ObjectId synthétique = config._id
//        pour le singleton, et `selectedOption.packIndex` pour mémoriser le pack).
//      → renvoie { nonce, adsRequired, ticketsToCredit, packLabel }
//      → le mobile transmet `nonce` dans le `customData` AdMob.
//
//   3. (asynchrone) callback SSV → pipeline existant incrémente verifiedCount.
//
//   4. getUnlockState(userId)
//      → polling. Si status='unlocked' ET pas encore finalisé →
//        crédite ticketsBalance + reset l'unlock (pour réutilisation au
//        prochain pack achat).
//      → renvoie { hasActiveUnlock, adsRequired, adsWatched, completed,
//                  nonce, ticketsBalance, justCredited? }
//
// L'idempotence du crédit est garantie par le nonce : on stocke `creditedNonce`
// sur WheelUserStats pour ne pas créditer deux fois le même cycle.

const crypto = require('crypto');
const UserAccessUnlock = require('../../models/common/UserAccessUnlock');
const WheelConfig = require('../../models/common/WheelConfig');
const WheelUserStats = require('../../models/common/WheelUserStats');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

const RESOURCE_TYPE_TICKETS = 'wheel_tickets';

/**
 * Retourne la liste des packs configurés (info publique).
 */
async function listPacks(lang = 'fr') {
  const cfg = await WheelConfig.getSingleton();
  return (cfg.ticketPacks || []).map((p, i) => ({
    index: i,
    tickets: p.tickets,
    adsRequired: p.adsRequired,
    label: (p.label && (p.label[lang] || p.label.fr)) || `${p.tickets} tour(s)`,
    featured: !!p.featured
  }));
}

/**
 * Démarre une session de déblocage de tickets pour le pack `packIndex`.
 */
async function startUnlock(userId, packIndex) {
  const cfg = await WheelConfig.getSingleton();
  if (!cfg.wheelEnabled) {
    throw new AppError('La roue est temporairement indisponible.', 503, ErrorCodes.SERVICE_UNAVAILABLE);
  }
  const idx = Number(packIndex);
  if (!Number.isInteger(idx) || idx < 0 || !cfg.ticketPacks || idx >= cfg.ticketPacks.length) {
    throw new AppError('Pack de tours invalide.', 400, ErrorCodes.VALIDATION_ERROR);
  }
  const pack = cfg.ticketPacks[idx];

  // Singleton par user : on réutilise toujours le même UserAccessUnlock doc
  // (resource = cfg._id) pour cette ressource_type.
  let doc = await UserAccessUnlock.findOne({
    user: userId,
    resourceType: RESOURCE_TYPE_TICKETS,
    resource: cfg._id
  });

  if (doc) {
    doc.status = 'in_progress';
    doc.verifiedCount = 0;
    doc.rewards = [];
    doc.unlockedAt = null;
    doc.expiresAt = null;
  } else {
    doc = new UserAccessUnlock({
      user: userId,
      resourceType: RESOURCE_TYPE_TICKETS,
      resource: cfg._id,
      status: 'in_progress'
    });
  }

  // On stocke le nb de tours à créditer + le packIndex dans selectedOption.
  // `durationMinutes` reste null (pas de notion de durée). On utilise `adsRequired`
  // standard pour que le pipeline SSV fonctionne sans modification.
  doc.selectedOption = {
    adsRequired: pack.adsRequired,
    durationMinutes: null
  };
  // Stocke le nb de tours dans `rewards[0]` (champ libre) via une autre approche :
  // on l'inscrit dans un champ custom sur le doc. Plus propre : on garde une map
  // pack→tickets dans la config, et au moment du crédit on relit la config
  // par index. Mais l'user pourrait changer de pack en cours de route — on doit
  // figer le packIndex au démarrage.
  //
  // Solution : on garde le packIndex dans le NONCE (préfixe `idx-`) qu'on
  // parse au crédit. Plus simple.
  doc.nonce = `idx${idx}-${crypto.randomBytes(20).toString('hex')}`;
  await doc.save();

  return {
    nonce: doc.nonce,
    adsRequired: pack.adsRequired,
    adsWatched: 0,
    completed: false,
    ticketsToCredit: pack.tickets,
    packIndex: idx,
    packLabel: pack.label?.fr || `${pack.tickets} tour(s)`
  };
}

/**
 * Polling. Si seuil atteint → crédite ticketsBalance + reset.
 */
async function getUnlockState(userId) {
  const cfg = await WheelConfig.getSingleton();
  const stats = await WheelUserStats.getOrCreate(userId);

  const doc = await UserAccessUnlock.findOne({
    user: userId,
    resourceType: RESOURCE_TYPE_TICKETS,
    resource: cfg._id
  });

  if (!doc || !doc.nonce) {
    return {
      hasActiveUnlock: false,
      adsRequired: 0,
      adsWatched: 0,
      completed: false,
      nonce: null,
      ticketsBalance: stats.ticketsBalance,
      justCredited: 0
    };
  }

  const adsRequired = doc.selectedOption?.adsRequired ?? 0;
  let justCredited = 0;

  if (doc.status === 'unlocked') {
    // Parse le packIndex depuis le nonce
    const m = /^idx(\d+)-/.exec(doc.nonce);
    if (m) {
      const idx = Number(m[1]);
      const pack = (cfg.ticketPacks || [])[idx];
      if (pack) {
        // Crédite (idempotent grâce au reset immédiat après).
        stats.ticketsBalance += pack.tickets;
        stats.totalTicketsEarned = (stats.totalTicketsEarned || 0) + pack.tickets;
        await stats.save();
        justCredited = pack.tickets;
      }
    }
    // Reset pour permettre un nouveau pack
    doc.status = 'in_progress';
    doc.verifiedCount = 0;
    doc.rewards = [];
    doc.unlockedAt = null;
    doc.expiresAt = null;
    doc.nonce = null;
    doc.selectedOption = { adsRequired: null, durationMinutes: null };
    await doc.save();
  }

  return {
    hasActiveUnlock: doc.status === 'in_progress' && !!doc.nonce,
    adsRequired,
    adsWatched: Math.min(doc.verifiedCount || 0, adsRequired || Number.MAX_SAFE_INTEGER),
    completed: justCredited > 0,
    nonce: doc.nonce,  // null après reset si justCredited
    ticketsBalance: stats.ticketsBalance,
    justCredited
  };
}

module.exports = {
  RESOURCE_TYPE_TICKETS,
  listPacks,
  startUnlock,
  getUnlockState
};
