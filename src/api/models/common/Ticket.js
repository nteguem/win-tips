const mongoose = require("mongoose");
const { buildLegacyTicketPublication, publicationOutcome, stripPublicationMarker } = require('../../services/common/legacyTicketPublication');

const TicketSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true
  },
  isVisible: {
    type: Boolean,
    default: false
  },
  // Permanent, system-owned publication marker. Pending means no provider has
  // been called. Sending/uncertain are deliberately never replayed automatically.
  publicationNotification: {
    notificationId: String,
    status: { type: String, enum: ['pending', 'sending', 'sent', 'uncertain', 'not_needed'] },
    reservedAt: Date,
    startedAt: Date,
    finishedAt: Date,
    reason: String,
    counts: { accepted: Number, failed: Number, skipped: Number, unreachable: Number }
  },
  closingAt: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'closed', 'draft'],
    default: 'active'
  },

  // Résultat consolidé dérivé des prédictions du ticket. Recalculé par le
  // cron de correction (juste après la correction des pronostics) et par la
  // correction manuelle. Règle :
  //   - won  : tous les pronostics décidés sont 'won' (au moins 1 décidé)
  //   - lost : au moins 1 pronostic 'lost'
  //   - pending : il reste des pronostics 'pending' et aucun 'lost'
  //   - void : uniquement des 'void' (cas marginal)
  // Champ distinct de `status` pour ne pas casser la logique métier existante.
  result: {
    type: String,
    enum: ['pending', 'won', 'lost', 'void'],
    default: 'pending'
  },

  // Dernière fois que le résultat a été recalculé.
  resultUpdatedAt: {
    type: Date,
    default: null
  },

  // Clé d'idempotence pour la synchro sortante (cette app → WinTips).
  // Quand un ticket est poussé à WinTips, on mémorise son ID distant pour
  // éviter de recréer le ticket en boucle aux publications suivantes.
  externalRefs: {
    wintips: { type: String, default: null }
  }
}, {
  timestamps: true
});

// Index composé pour les requêtes principales
TicketSchema.index({
  date: -1,
  category: 1,
  isVisible: 1
});

// Index simple sur la date pour les requêtes par plage de dates
TicketSchema.index({
  date: -1
});

// Index sur la catégorie pour les filtres par catégorie
TicketSchema.index({
  category: 1
});

// Index sur le status pour les requêtes filtrées par status
TicketSchema.index({
  status: 1
});

// Index sur le résultat (dashboard, stats)
TicketSchema.index({
  result: 1
});

// Index composé pour les requêtes fréquentes de tickets visibles par date
TicketSchema.index({
  isVisible: 1,
  date: -1
});


// Reserve before changing visibility: a concurrent publication that sees the
// newly-visible row must distinguish this first publication from an old ticket.
TicketSchema.pre('findOneAndUpdate', async function () {
  const update = stripPublicationMarker(this.getUpdate() || {});
  this.setUpdate(update);
  const visible = Object.hasOwn(update, 'isVisible') ? update.isVisible : update.$set?.isVisible;
  if (visible !== true && visible !== false) return;
  const previous = await this.model.findOne(this.getQuery()).select('_id isVisible publicationNotification').lean();
  if (!previous || previous.publicationNotification?.notificationId) return;
  const notificationId = `ticket-published:${previous._id}`;
  if (previous.isVisible === true) {
    // Covers both true->true and an old visible ticket being hidden. Neither a
    // later resave nor hide/republish may send a historical publication again.
    await this.model.collection.updateOne({ _id: previous._id, isVisible: true,
      'publicationNotification.notificationId': { $exists: false } }, { $set: {
      publicationNotification: { notificationId, status: 'not_needed', reason: 'already_published_legacy', finishedAt: new Date() }
    } });
  } else if (visible === true) {
    await this.model.collection.updateOne({ _id: previous._id, isVisible: { $ne: true },
      'publicationNotification.notificationId': { $exists: false } }, { $set: {
      publicationNotification: { notificationId, status: 'pending', reservedAt: new Date() }
    } });
  }
});

TicketSchema.post('findOneAndUpdate', async function (doc) {
  const update = this.getUpdate() || {};
  if (!doc || (update.isVisible !== true && update.$set?.isVisible !== true)) return;
  if (doc.publicationNotification?.notificationId && doc.publicationNotification.status !== 'pending') return;
  const notificationId = `ticket-published:${doc._id}`;
  const pending = { _id: doc._id, isVisible: true,
    'publicationNotification.notificationId': notificationId, 'publicationNotification.status': 'pending' };
  let claimed = false;
  try {
    const Category = mongoose.model('Category');
    const category = await Category.findById(doc.category);
    const skipReason = !category ? 'category_missing' : category.isActive === false ? 'category_inactive'
      : category.catalogueArchived === true ? 'category_archived' : category.editorialSource ? 'editorial_category'
      : process.env.DISABLE_PUSH_NOTIFICATIONS === 'true' ? 'notifications_disabled' : null;
    if (skipReason) {
      await this.model.collection.updateOne(pending, { $set: {
        'publicationNotification.status': 'not_needed', 'publicationNotification.reason': skipReason,
        'publicationNotification.finishedAt': new Date()
      } });
      return;
    }
    const notification = buildLegacyTicketPublication(doc, category);
    // Atomic transition before any provider call, including OneSignal. Another
    // request/restart cannot reclaim sending, sent, uncertain or not_needed.
    const result = await this.model.collection.updateOne(pending, { $set: {
      'publicationNotification.status': 'sending', 'publicationNotification.startedAt': new Date()
    } });
    if (result.modifiedCount !== 1) return;
    claimed = true;
    const response = await require('../../services/common/notificationService').sendToAll(notification);
    const outcome = publicationOutcome(response);
    await this.model.collection.updateOne({ _id: doc._id,
      'publicationNotification.notificationId': notificationId, 'publicationNotification.status': 'sending' }, { $set: {
      'publicationNotification.status': outcome.status, 'publicationNotification.counts': outcome.counts,
      ...(outcome.reason ? { 'publicationNotification.reason': outcome.reason } : {}),
      'publicationNotification.finishedAt': new Date()
    } });
  } catch (error) {
    if (claimed) await this.model.collection.updateOne({ _id: doc._id,
      'publicationNotification.notificationId': notificationId, 'publicationNotification.status': 'sending' }, { $set: {
      'publicationNotification.status': 'uncertain', 'publicationNotification.reason': 'transport_interrupted',
      'publicationNotification.finishedAt': new Date()
    } }).catch(() => {});
    // A failure before the sending claim leaves pending safe to retry. A failed
    // marker write after transport leaves sending/uncertain, never replayable.
    console.error('Legacy ticket notification not confirmed', { ticketId: String(doc._id),
      phase: claimed ? 'transport_or_receipt' : 'before_transport', code: error.code || error.name });
  }
});

module.exports = mongoose.model("Ticket", TicketSchema);
