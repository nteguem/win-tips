const { currencyCode, priceFor, canPurchaseInCurrency, validPrecision } = require('./packagePricing');

const YEAR_END_PACKAGE_ID = 'c97d577e0912523aab9f1bfb';

function mapValue(value, currency) {
  return value instanceof Map ? value.get(currency) : value && value[currency];
}

/** A public quotation, never an entitlement, payment intent or conversion. */
function publicVipOffer(pkg, requestedCurrency) {
  const currency = currencyCode(requestedCurrency);
  if (!currency || !pkg || String(pkg._id) !== YEAR_END_PACKAGE_ID || pkg.isActive !== true ||
      (pkg.paymentMode || 'money') !== 'money' || !Number.isSafeInteger(pkg.duration) || pkg.duration < 1 ||
      !Array.isArray(pkg.categories) || !pkg.categories.some(category => category && category.isVip === true && category.isActive !== false) ||
      !canPurchaseInCurrency(pkg, currency)) return null;

  const price = priceFor(pkg, currency);
  const offer = { packageId: YEAR_END_PACKAGE_ID, currency, price, durationDays: pkg.duration };
  // The catalogue's explicit saving belongs to this very package and duration.
  // Missing/invalid savings never turn into a manufactured "80%" comparison.
  const saving = mapValue(pkg.economy, currency);
  const previousPrice = typeof saving === 'number' ? price + saving : null;
  if (Number.isFinite(saving) && saving > 0 && Number.isFinite(previousPrice) &&
      previousPrice > price && validPrecision(currency, previousPrice)) {
    offer.previousPrice = previousPrice;
  }
  return offer;
}

module.exports = { YEAR_END_PACKAGE_ID, publicVipOffer };
