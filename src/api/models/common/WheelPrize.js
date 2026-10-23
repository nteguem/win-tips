// src/api/models/common/WheelPrize.js
//
// Lots gagnables sur la roue de la chance.
// Tirage pondéré par `weight`. Caps (jour/mois/lifetime/window) configurables
// pour limiter la distribution des gros lots et garantir la viabilité économique.
//
// Un lot marqué `isFallback: true` sert de filet : si TOUS les autres lots
// sont capés ou désactivés, c'est lui qui est tiré. Typiquement le segment
// "Dommage / Perdu".

const mongoose = require('mongoose');

const WheelPrizeSchema = new mongoose.Schema({
  name: {
    fr: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true }
  },

  // Type de récompense — détermine la logique de distribution :
  //   none         : segment "Dommage" (aucun cadeau)
  //   free_spin    : crédite +N tours gratuits à l'user (consommé au prochain spin)
  //   cash         : crédite Wallet (amount + currency)
  //   subscription : crée une Subscription temporaire (packageId + durationHours)
  //   physical     : lot physique (ex: iPhone) — pending livraison admin
  type: {
    type: String,
    enum: ['none', 'free_spin', 'cash', 'subscription', 'physical'],
    required: true
  },

  // Détails par type — seul le bloc correspondant au `type` est lu.
  // Pour `cash` : montants multi-devises (pattern Package.pricing). On lit
  // `amounts[user.currency]`, fallback sur `amounts[defaultCurrency]` de la
  // config wheel. Les anciens champs amount/currency sont conservés UNIQUEMENT
  // comme fallback de rétro-compat — l'admin doit migrer vers `amounts`.
  cash: {
    amounts: {
      type: Map,
      of: { type: Number, min: 0 },
      default: () => new Map()
    },
    // Rétro-compat (à supprimer une fois la migration faite) :
    amount: { type: Number, min: 0, default: null },
    currency: { type: String, default: 'XAF', uppercase: true }
  },
  subscription: {
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    durationHours: { type: Number, min: 1, default: 24 }
  },
  physical: {
    label: { type: String, default: null },
    notes: { type: String, default: null }
  },
  freeSpin: {
    count: { type: Number, min: 1, default: 1 }
  },

  // Apparence visuelle sur la roue
  color: { type: String, default: '#FFD700' },
  icon: { type: String, default: null },        // emoji ou nom d'icône
  order: { type: Number, default: 0 },          // position visuelle sur la roue (0..N-1)

  // Probabilité — poids relatif. Les probas sont normalisées sur la somme
  // des `weight` des lots disponibles. weight=0 = jamais tiré (kill-switch
  // doux sans désactiver le lot visuellement).
  weight: { type: Number, min: 0, default: 1 },

  // Kill-switch dur (lot retiré complètement du pool ET de la roue côté UI)
  enabled: { type: Boolean, default: true },

  // Caps anti-abus / anti-ruine — null = pas de cap
  caps: {
    globalDay: { type: Number, min: 0, default: null },     // max gagnants/jour (tous users)
    globalMonth: { type: Number, min: 0, default: null },   // max gagnants/mois (tous users)
    userDay: { type: Number, min: 0, default: null },       // max/user/jour
    userMonth: { type: Number, min: 0, default: null },     // max/user/mois
    userLifetime: { type: Number, min: 0, default: null },  // max/user à vie
    // Fenêtre glissante — ex: max 1 iPhone tous les 120 jours
    window: {
      days: { type: Number, min: 1, default: null },
      max: { type: Number, min: 0, default: null }
    }
  },

  // Marqueur du segment de repli (typiquement "Dommage").
  isFallback: { type: Boolean, default: false }
}, { timestamps: true });

WheelPrizeSchema.index({ enabled: 1, order: 1 });
WheelPrizeSchema.index({ isFallback: 1 });

// Fallback de devise quand la map n'a pas la devise demandée.
// On aligne sur les devises utilisées dans les packages (XAF, XOF) ; pour
// tout pays hors de cette zone, on retombe sur USD.
const CURRENCY_FALLBACK = 'USD';

/**
 * Retourne le montant cash pour la devise demandée.
 * Ordre :
 *   1. amounts[currency]    (devise locale de l'user)
 *   2. amounts[USD]         (fallback universel — devises hors XAF/XOF)
 *   3. amount (legacy)
 */
WheelPrizeSchema.methods.getCashAmountFor = function (currency) {
  if (this.type !== 'cash') return null;
  const cur = String(currency || CURRENCY_FALLBACK).toUpperCase();
  const map = this.cash?.amounts;
  if (map && typeof map.has === 'function' && map.size > 0) {
    if (map.has(cur)) return map.get(cur);
    if (map.has(CURRENCY_FALLBACK)) return map.get(CURRENCY_FALLBACK);
  }
  return this.cash?.amount ?? null;
};

/**
 * Retourne la devise effectivement utilisée (currency demandée si dispo, sinon USD).
 */
WheelPrizeSchema.methods.getCashCurrency = function (currency) {
  if (this.type !== 'cash') return null;
  const cur = String(currency || CURRENCY_FALLBACK).toUpperCase();
  const map = this.cash?.amounts;
  if (map && typeof map.has === 'function') {
    if (map.has(cur)) return cur;
    if (map.has(CURRENCY_FALLBACK)) return CURRENCY_FALLBACK;
  }
  return this.cash?.currency || CURRENCY_FALLBACK;
};

// Vue publique pour le client mobile — masque les probabilités et les caps.
// `currency` permet de retourner le montant dans la devise locale de l'user
// (fallback USD si la devise n'est pas configurée sur le lot).
WheelPrizeSchema.methods.toPublicJSON = function (lang = 'fr', currency) {
  return {
    _id: this._id,
    name: (this.name && (this.name[lang] || this.name.fr)) || '',
    type: this.type,
    color: this.color,
    icon: this.icon,
    order: this.order,
    cash: this.type === 'cash'
      ? {
          amount: this.getCashAmountFor(currency),
          currency: this.getCashCurrency(currency)
        }
      : null,
    physical: this.type === 'physical'
      ? { label: this.physical?.label }
      : null,
    subscription: this.type === 'subscription'
      ? { durationHours: this.subscription?.durationHours }
      : null,
    freeSpin: this.type === 'free_spin'
      ? { count: this.freeSpin?.count }
      : null
  };
};

// Vue admin — inclut probas, caps, état complet. Sérialise la Map en objet plat.
WheelPrizeSchema.methods.toAdminJSON = function () {
  const obj = this.toObject();
  if (obj.cash && obj.cash.amounts instanceof Map) {
    obj.cash.amounts = Object.fromEntries(obj.cash.amounts);
  } else if (obj.cash && obj.cash.amounts && typeof obj.cash.amounts === 'object') {
    // déjà sérialisé en objet par toObject
  }
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('WheelPrize', WheelPrizeSchema);
