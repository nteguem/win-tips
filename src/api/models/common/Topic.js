const mongoose = require('mongoose');

const topicSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  
  city: {
    type: String,
    required: true,
    trim: true
  },
  
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

topicSchema.index({ name: 1 });
topicSchema.index({ city: 1 });
topicSchema.index({ isActive: 1 });

topicSchema.statics.findOrCreate = async function(name, city) {
  let topic = await this.findOne({ name });
  
  if (!topic) {
    topic = await this.create({ name, city });
  }
  
  return topic;
};

module.exports = mongoose.model('Topic', topicSchema);