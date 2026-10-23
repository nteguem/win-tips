// Transitional coexistence for already deployed clients. This never converts
// an editorial item into a legacy ticket or invents a sports-provider ID.
const enabled = () => process.env.WINTIPS_EDITORIAL_LEGACY_BRIDGE === 'true';
const capable = req => !!(req && req.headers && req.headers['x-wintips-editorial'] === '1');
const hasLegacyMapping = category => !!(category && Array.isArray(category.externalSources) && category.externalSources.length);
const applies = category => !!(category && category.editorialSource && enabled() && hasLegacyMapping(category));
const pauseLegacyImports = category => !!(category && category.editorialSource && !applies(category));

function showLegacyTicket(category, req, { detail = false } = {}) {
  if (!category || !category.editorialSource) return true;
  if (!applies(category) || capable(req)) return false;
  // The existing legacy endpoint has an old isVip-omitted case. Do not widen
  // that case to editorial VIP categories while enabling the bridge.
  if (category.isVip && (!req.user || (!detail && req.query?.isVip !== 'true'))) return false;
  return true;
}

module.exports = { enabled, capable, hasLegacyMapping, applies, pauseLegacyImports, showLegacyTicket };
