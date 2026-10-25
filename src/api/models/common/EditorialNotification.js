const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  appId: { type: String, required: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  source: { type: String, required: true },
  editionDate: { type: String, required: true },
  notificationId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'retry_pending', 'completed', 'no_audience', 'review_required'], default: 'pending' },
  leaseUntil: Date,
  lockToken: String,
  afterDeviceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  passes: { type: Number, default: 0 },
  nextAttemptAt: Date,
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastErrorCode: String,
  completedAt: Date,
  // Frozen only on the first ledger insert. Missing fields on legacy ledgers
  // deliberately retain their historical generic message on all retries.
  editorialCopy: { type: mongoose.Schema.Types.Mixed },
  editorialCopySha256: String,
  itemHash: String,
}, { timestamps: true, autoCreate: false, autoIndex: false });

schema.index({ appId: 1, categoryId: 1, source: 1, editionDate: 1 }, { unique: true, name: 'editorial_notification_identity_unique' });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 }, { name: 'editorial_notification_pending' });
module.exports = mongoose.models.EditorialNotification || mongoose.model('EditorialNotification', schema);
