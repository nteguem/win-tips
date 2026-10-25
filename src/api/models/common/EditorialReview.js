const mongoose = require('mongoose');
const { REVIEW_IDENTITY_INDEX } = require('../../services/common/editorialIndexIdentity');

// One opinion per reader and coupon edition. The explicit provisioning command
// installs the unique index before writes; HTTP requests never create indexes.
const schema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  editionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, required: true, maxlength: 40 },
  rating: { type: Number, min: 1, max: 5, required: true, validate: Number.isInteger },
  comment: { type: String, maxlength: 1500, default: '' },
}, { timestamps: true, autoCreate: false, autoIndex: false });
schema.index({ ...REVIEW_IDENTITY_INDEX.key }, { unique: true, name: REVIEW_IDENTITY_INDEX.name });
schema.index({ categoryId: 1, editionDate: 1, createdAt: -1, _id: -1 }, { name: 'editorial_review_edition_recent' });
module.exports = mongoose.models.EditorialReview || mongoose.model('EditorialReview', schema);
