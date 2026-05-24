/**
 * @fileoverview Synchronisation sortante : cette API → WinTips.
 *
 * Quand un ticket est publié dans CETTE app (`isVisible = true`), on
 * pousse l'info vers WinTips via ses webhooks internes
 * (`/api/internal/sync/tickets`). WinTips décide lui-même si l'une de
 * ses catégories veut absorber le ticket (matching sur
 * `Category.externalSources`).
 *
 * Activé UNIQUEMENT si la variable d'env `SYNC_TARGET_WINTIPS_URL` est
 * définie sur ce déploiement. En pratique : PredictFoot la définit (pour
 * pousser vers WinTips), WinTips lui-même ne la définit PAS (évite la
 * boucle wintips → wintips).
 *
 * Fire-and-forget : toute erreur est loggée mais jamais propagée au
 * caller — la publication locale ne doit jamais être bloquée par un
 * échec de synchro distante.
 *
 * Pattern porté de `bigwin v2/src/api/services/admin/syncToWintipsService.js`.
 */
const axios = require('axios');
const mongoose = require('mongoose');
const logger = require('../../../utils/logger');

const WINTIPS_API_URL = (process.env.SYNC_TARGET_WINTIPS_URL || '').replace(/\/$/, '');
const SOURCE_APP_ID = process.env.APP_ID || 'app';
// Par convention : `system` = `APP_ID`. Côté wintips, la catégorie cible
// déclare un externalSource `{ system, appId, categoryId }` à matcher.
const SOURCE_SYSTEM = SOURCE_APP_ID;
const HTTP_TIMEOUT_MS = 10000;

function isConfigured() {
  return Boolean(WINTIPS_API_URL);
}

function url(path) {
  return `${WINTIPS_API_URL}/api/internal/sync${path}`;
}

/**
 * Pousse un ticket publié vers WinTips.
 *
 * Idempotent : si le ticket a déjà été synchronisé (champ
 * `externalRefs.wintips` renseigné), on appelle uniquement la route
 * `publish` (re-publier est sans effet si déjà visible). Sinon on déroule
 * create → bulk predictions → publish.
 *
 * @param {Object} doc Ticket Mongoose document (ou objet avec _id)
 */
async function maybeSyncTicket(doc) {
  if (!isConfigured()) return;
  if (!doc || !doc._id) return;

  const Ticket = mongoose.model('Ticket');
  const ticket = await Ticket.findById(doc._id).populate('category').lean();
  if (!ticket) return;
  if (!ticket.isVisible) return; // on ne pousse que les tickets publiés

  const sourceCategoryId = ticket.category?._id ? String(ticket.category._id) : null;
  if (!sourceCategoryId) {
    logger.warn(`[syncOutgoing] ticket ${ticket._id} sans catégorie peuplée, skip`);
    return;
  }

  try {
    let wintipsTicketId = ticket.externalRefs?.wintips || null;

    if (!wintipsTicketId) {
      // 1) Création côté WinTips : WinTips résout la catégorie cible via
      //    ses externalSources et clone le ticket (ou ignore si pas de mapping).
      const createResp = await axios.post(
        url('/tickets'),
        {
          sourceSystem: SOURCE_SYSTEM,
          sourceAppId: SOURCE_APP_ID,
          sourceCategoryId,
          title: ticket.title,
          date: ticket.date,
          closingAt: ticket.closingAt,
        },
        { timeout: HTTP_TIMEOUT_MS }
      );

      const data = createResp?.data?.data || {};
      if (data.ignored) {
        logger.info(
          `[syncOutgoing] ticket ${ticket._id} ignoré par WinTips (pas de mapping configuré)`
        );
        return;
      }
      wintipsTicketId = data._id || null;
      if (!wintipsTicketId) {
        throw new Error('Réponse WinTips sans _id sur create ticket');
      }

      // Mémoriser pour idempotence sur les publications suivantes.
      await Ticket.updateOne(
        { _id: ticket._id },
        { $set: { 'externalRefs.wintips': wintipsTicketId } }
      );
      logger.info(`[syncOutgoing] Ticket ${ticket._id} → WinTips ${wintipsTicketId} créé`);

      // 2) Cloner les prédictions du ticket.
      const Prediction = mongoose.model('Prediction');
      const preds = await Prediction.find({ ticket: ticket._id }).lean();
      if (preds.length > 0) {
        const payload = preds.map((p) => ({
          matchData: p.matchData,
          event: p.event,
          odds: p.odds,
          sport: p.sport,
          star: p.star,
        }));
        await axios.post(
          url(`/tickets/${wintipsTicketId}/predictions`),
          { predictions: payload },
          { timeout: HTTP_TIMEOUT_MS }
        );
        logger.info(
          `[syncOutgoing] ${preds.length} prédiction(s) envoyée(s) pour ${wintipsTicketId}`
        );
      }
    }

    // 3) Publier (toujours appelé — l'appel est idempotent côté WinTips).
    await axios.put(url(`/tickets/${wintipsTicketId}/publish`), {}, { timeout: HTTP_TIMEOUT_MS });
    logger.info(`[syncOutgoing] Ticket WinTips ${wintipsTicketId} publié`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error(`[syncOutgoing] échec sync ticket=${doc._id} : ${JSON.stringify(detail)}`);
  }
}

module.exports = { maybeSyncTicket };
