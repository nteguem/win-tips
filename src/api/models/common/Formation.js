const mongoose = require('mongoose');

const formationSchema = new mongoose.Schema({
  title: {
    fr: {
      type: String,
      required: [true, 'Le titre en français est requis']
    },
    en: {
      type: String,
      required: [true, 'Le titre en anglais est requis']
    }
  },
  description: {
    fr: {
      type: String,
      required: [true, 'La description en français est requise']
    },
    en: {
      type: String,
      required: [true, 'La description en anglais est requise']
    }
  },
  htmlContent: {
    fr: {
      type: String,
    },
    en: {
      type: String,
    }
  },
  isAccessible: {
    type: Boolean,
    default: true
  },
  requiredPackages: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Package'
  }],
  order: {
    type: Number,
    default: 0,
    index: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index pour optimiser les requêtes
formationSchema.index({ isActive: 1 });
formationSchema.index({ isAccessible: 1 });
formationSchema.index({ requiredPackages: 1 });
formationSchema.index({ order: 1, createdAt: -1 }); // Index composé pour le tri

const Formation = mongoose.model('Formation', formationSchema);

module.exports = Formation;