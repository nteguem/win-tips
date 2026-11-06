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

const recovery = require('../common/rewardedWheelRecovery').createRecovery({
  UserAccessUnlock, WheelConfig, WheelUserStats, AppError, ErrorCodes, multiTenant: false
});
module.exports = { RESOURCE_TYPE_TICKETS, listPacks, ...recovery };
