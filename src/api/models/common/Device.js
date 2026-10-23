const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true
  },
  
  // N'est PLUS obligatoire depuis la migration FCM : un device qui s'enregistre
  // avec un token FCM et sans OneSignal est parfaitement joignable. L'exiger
  // ferait echouer la validation sur tout nouvel installeur une fois OneSignal
  // retire, le 01/10/2026.
  playerId: {
    type: String,
    unique: true,
    sparse: true,
    default: null
  },
  
  // --- Migration OneSignal -> FCM ---------------------------------------
  // Le token FCM natif. Deux origines possibles :
  //  - 'onesignal_export' : recupere via l'export CSV OneSignal (colonne
  //    `identifier`). Valide en dryRun : 96,5 % des tokens exportes sont
  //    acceptes par nos projets Firebase.
  //  - 'sdk' : remonte par l'app via firebase_messaging (getToken /
  //    onTokenRefresh). Fait autorite des qu'il existe — forcement plus frais.
  // Pas de `sparse` ici : l'index unique partiel est declare plus bas.
  fcmToken: {
    type: String
  },

  fcmTokenSource: {
    type: String,
    enum: ['onesignal_export', 'sdk'],
    default: null
  },

  fcmTokenUpdatedAt: {
    type: Date,
    default: null
  },

  // Resolution du provider AU NIVEAU DU DEVICE (et non par message) : on ne
  // sait pas detecter en temps reel qu'un envoi OneSignal a echoue pour un
  // destinataire donne. Le critere est donc « ce device a-t-il un token FCM
  // exploitable ? ».
  //   fcm         -> envoi FCM (cible)
  //   onesignal   -> pas encore de token, filet OneSignal (jusqu'au 30/09/2026)
  //   both        -> les deux disponibles, FCM prioritaire
  //   unreachable -> token mort (UNREGISTERED) et plus de playerId
  pushProvider: {
    type: String,
    enum: ['onesignal', 'fcm', 'both', 'unreachable'],
    default: 'onesignal'
  },

  // Renseigne depuis Build.MANUFACTURER : indispensable pour mesurer le taux
  // de livraison reel par constructeur, les surcouches Transsion/Xiaomi tuant
  // les processus en arriere-plan sans que FCM ne signale quoi que ce soit.
  manufacturer: {
    type: String,
    trim: true,
    default: null
  },

  // Derniere erreur FCM rencontree, pour le diagnostic et la purge.
  lastPushError: {
    code: String,
    at: Date
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

  // Optional for old clients. The selected app language takes precedence over
  // the OS language; an omitted registration field never resets preferences.
  language: { type: String, enum: ['fr', 'en'], default: undefined },
  deviceLanguage: { type: String, enum: ['fr', 'en'], default: undefined },
  notificationsEnabled: { type: Boolean, default: true },
  editorialSchemaVersion: { type: Number, enum: [1], default: undefined },
  
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

// --- Index de la migration FCM ------------------------------------------
// Unicite du token : un meme token FCM ne doit jamais exister sur deux devices
// (sinon double notification). Partiel, la majorite n'en ayant pas encore.
deviceSchema.index(
  { fcmToken: 1 },
  { unique: true, partialFilterExpression: { fcmToken: { $type: 'string' } } }
);
// Chemin d'envoi principal : resolution d'audience par provider + fraicheur.
deviceSchema.index({ pushProvider: 1, isActive: 1 });
deviceSchema.index({ fcmTokenUpdatedAt: -1 });

module.exports = mongoose.model('Device', deviceSchema);
