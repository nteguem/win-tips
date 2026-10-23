/**
 * @fileoverview Conversion des devises vers le XAF (devise pivot du backoffice).
 *
 * XAF et XOF sont en parité fixe (zone franc CFA). Les autres taux sont
 * indicatifs et servent uniquement à l'agrégation des revenus dans les
 * tableaux de bord admin — ils ne sont jamais utilisés pour facturer un client.
 */

const CURRENCY_TO_XAF = {
  XAF: 1,
  XOF: 1,
  EUR: 655.957,
  USD: 615,
  CDF: 0.22,
  GNF: 0.072,
  GMD: 8.5,
  NGN: 0.38,
  KES: 4.8,
  GHS: 46,
  EGP: 12.8,
  ZAR: 33,
};

/**
 * Convertit un montant exprimé dans `currency` en son équivalent XAF (arrondi).
 * Renvoie 0 si le montant est nul ou la devise inconnue.
 * @param {number} amount
 * @param {string} currency
 * @returns {number}
 */
function toXAF(amount, currency) {
  if (!amount) return 0;
  const rate = CURRENCY_TO_XAF[(currency || 'XAF').toUpperCase()];
  if (!rate) return 0;
  return Math.round(amount * rate);
}

module.exports = { CURRENCY_TO_XAF, toXAF };
