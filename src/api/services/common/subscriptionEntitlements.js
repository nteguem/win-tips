const { isManagedCatalogue } = require('./packagePricing');

function categoryRights(subscription, pkg = subscription && subscription.package) {
  if (subscription && Array.isArray(subscription.categorySnapshot)) return subscription.categorySnapshot;
  return (pkg && Array.isArray(pkg.categories)) ? pkg.categories : [];
}
function snapshotForPackage(pkg) {
  return isManagedCatalogue(pkg) ? { categorySnapshot: [...new Set((pkg.categories || []).map(value => String(value._id || value)))] } : {};
}
module.exports = { categoryRights, snapshotForPackage };
