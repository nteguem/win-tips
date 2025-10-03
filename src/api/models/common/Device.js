const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true
  },
  
  playerId: {
    type: String,
    required: true,
    unique: true,
    sparse: true
  },
  
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  platform: {
    type: String,
    enum: ['android', 'ios'],
    required: true
  },
  
  deviceInfo: {
    model: String,
    osVersion: String,
    appVersion: String
  },
  
  isActive: {
    type: Boolean,
    default: true
  },
  
  userType: {
    type: String,
    enum: ['guest', 'registered', 'vip'],
    default: 'guest'
  },
  
  lastActiveAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

deviceSchema.index({ userType: 1, isActive: 1 });
deviceSchema.index({ user: 1, isActive: 1 });
deviceSchema.index({ playerId: 1, isActive: 1 });

deviceSchema.methods.linkToUser = function(userId) {
  this.user = userId;
  this.userType = 'registered';
  return this.save();
};

deviceSchema.methods.unlinkFromUser = function() {
  this.user = null;
  this.userType = 'guest';
  return this.save();
};

deviceSchema.statics.getByUserType = function(userType) {
  return this.find({ 
    userType, 
    isActive: true,
    playerId: { $exists: true, $ne: null }
  });
};

deviceSchema.pre('save', function(next) {
  next();
});

module.exports = mongoose.model('Device', deviceSchema);