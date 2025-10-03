const mongoose = require("mongoose");

const CategorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  description: String,
  icon: {
    type: String,
    default: "🧾"
  },
  successRate: {
    type: Number,
    default: 50,
    min: 0,
    max: 100,
    validate: {
      validator: function(v) {
        return v >= 0 && v <= 100;
      },
      message: 'Success rate must be between 0 and 100'
    }
  },
  isVip: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model("Category", CategorySchema);