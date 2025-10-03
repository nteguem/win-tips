const mongoose = require("mongoose");

const PredictionSchema = new mongoose.Schema({
  ticket: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Ticket",
    required: true
  },
  
  correctionAttempts: { 
    type: Number, 
    default: 0 
  },
  
  // pour gérer la flexibilité des différents sports
  matchData: mongoose.Schema.Types.Mixed,
  
  // pour gérer les événements hippiques et autres
  event: mongoose.Schema.Types.Mixed,
  
  odds: {
    type: Number,
    required: true
  },
  
  status: {
    type: String,
    enum: ['pending', 'won', 'lost', 'void'],
    default: 'pending'
  },
  
  sport: {
    id: String,
    name: String,
    icon: String
  },
    star: {
    type: Number,
    min: 0,
    max: 5,
    default: 0
  },
  
  reason: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

PredictionSchema.index(
  { ticket: 1, 'matchData.id': 1, 'event.id': 1 },
  { unique: true }
);

module.exports = mongoose.model("Prediction", PredictionSchema);