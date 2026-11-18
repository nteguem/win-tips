// Prices are explicit amounts, never a currency conversion or zero fallback.
function currencyCode(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    const error = new Error('Devise invalide'); error.statusCode = 400; throw error;
  }
  return value.toUpperCase();
}
function priceFor(pkg, currency) {
  const map = pkg && pkg.pricing;
  const value = map instanceof Map ? map.get(currency) : map && map[currency];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && validPrecision(currency, value) ? value : null;
}
function validPrecision(currency, amount) {
  if (['XAF', 'XOF', 'GNF'].includes(currency)) return Number.isInteger(amount);
  if (['EUR', 'USD'].includes(currency)) return Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8;
  return true;
}
function validateExplicitPricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing) || !Object.keys(pricing).length ||
    Object.entries(pricing).some(([currency, amount]) => !/^[A-Z]{3}$/.test(currency) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !validPrecision(currency, amount))) {
    const error = new Error('Au moins un prix explicite positif par devise est requis'); error.statusCode = 400; throw error;
  }
  return pricing;
}
function canPurchaseInCurrency(pkg, currency) {
  if ((pkg.paymentMode || 'money') === 'ads') return true;
  if (priceFor(pkg, currency) === null) return false;
  // These currencies use the existing Google Play rail. Having a price in
  // the BO does not invent a Play product, activate a rail or create a SKU.
  return !['USD', 'EUR'].includes(currency) || !!(pkg.availableOnGooglePlay && typeof pkg.googleProductId === 'string' && pkg.googleProductId.trim());
}
const isManagedCatalogue = pkg => typeof pkg?.catalogueKey === 'string' && pkg.catalogueKey.startsWith('wintips-rdj-catalogue-v1:package:');
function managedGooglePrice(pkg, productId, requestedCurrency) {
  if (!isManagedCatalogue(pkg)) return null;
  const currency = currencyCode(requestedCurrency), amount = currency && priceFor(pkg, currency);
  if (!pkg.availableOnGooglePlay || pkg.googleProductType !== 'ONE_TIME_PRODUCT' || pkg.googleProductId !== productId || !currency || amount === null) {
    const error = new Error('Produit Google Play ou prix explicite non configure pour cette devise'); error.statusCode = 400; throw error;
  }
  // ProductPurchase v1 verifies purchase state but contains no paid amount.
  // Keep the configured reference explicit; do not claim Google proved it.
  return { amount, currency, source: 'configured_catalogue_reference' };
}

// Historical bindings are private receipt-recovery snapshots. They are never
// returned as available products and never make an old SKU a checkout target.
// Disable the old Play purchase option before adding its retired binding.
function managedGooglePurchase(pkg, productId, requestedCurrency) {
  if (pkg.googleProductId === productId) {
    return { pkg, price: managedGooglePrice(pkg, productId, requestedCurrency), migration: null };
  }
  const matches = isManagedCatalogue(pkg) && Array.isArray(pkg.googleProductMigrations)
    ? pkg.googleProductMigrations.filter(row => row.productId === productId) : [];
  if (matches.length !== 1) throw new Error('Produit Google Play incompatible avec ce forfait');
  const migration = matches[0];
  const retiredAt = new Date(migration.retiredAt).getTime();
  if (!Number.isFinite(retiredAt) || retiredAt <= 0 || !Number.isFinite(migration.duration) || migration.duration <= 0 ||
      !Array.isArray(migration.categories) || migration.categories.length === 0) {
    throw new Error('Migration Google Play historique incomplete');
  }
  const snapshot = { ...(typeof pkg.toObject === 'function' ? pkg.toObject() : pkg),
    googleProductId: productId, pricing: migration.pricing, duration: migration.duration,
    categories: migration.categories };
  return { pkg: snapshot, price: managedGooglePrice(snapshot, productId, requestedCurrency),
    migration: { productId, retiredAt } };
}

function verifyGoogleMigrationReceipt(binding, data) {
  if (!binding.migration) return;
  // Retired products cannot start new checkouts. A legitimate deferred payment
  // can complete after retirement; retiredAt is audit metadata, not a payment
  // deadline. Only Google's paid receipt and timestamp are evidence.
  const raw = data.purchaseTimeMillis;
  const time = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : NaN;
  if (data.purchaseState !== 0 || (data.productId && data.productId !== binding.migration.productId) ||
      !Number.isSafeInteger(time) || time <= 0) {
    throw new Error('Achat Google Play historique non confirme');
  }
}
module.exports = { currencyCode, priceFor, canPurchaseInCurrency, validateExplicitPricing, validPrecision, isManagedCatalogue, managedGooglePrice,
  managedGooglePurchase, verifyGoogleMigrationReceipt };
