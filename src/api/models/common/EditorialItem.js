const mongoose = require('mongoose');
const { SOURCES } = require('../../services/common/editorialSources');

const EditorialItemSchema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  source: { type: String, enum: SOURCES.map(s => s.key), required: true },
  editionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  sourceId: { type: String, required: true, maxlength: 220 },
  kind: { type: String, enum: ['match', 'horse_racing', 'combine'], required: true },
  startsAtUtc: { type: Date, default: null },
  // The complete payload is normalized by editorialValidation before any write.
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  contentHash: { type: String, required: true },
  isPublished: { type: Boolean, default: true },
  // Legacy per-item marker, preserved on reimport. Actual opt-in category/day
  // delivery state is authoritative in EditorialNotification, not this field.
  notificationState: { type: String, enum: ['not_requested', 'pending', 'sent', 'failed'], default: 'not_requested' },
  notificationSentAt: { type: Date, default: null },
}, { timestamps: true, autoCreate: false, autoIndex: false });

EditorialItemSchema.index({ categoryId: 1, source: 1, editionDate: 1, sourceId: 1 }, { unique: true, name: 'editorial_identity_unique' });
EditorialItemSchema.index({ editionDate: -1, categoryId: 1, isPublished: 1, startsAtUtc: 1 }, { name: 'editorial_feed_by_date' });

module.exports = mongoose.models.EditorialItem || mongoose.model('EditorialItem', EditorialItemSchema);
