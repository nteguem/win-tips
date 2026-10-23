/**
 * @fileoverview Contrôleur admin des analytics de pronostics/coupons.
 */
const predictionsAnalyticsService = require('../../services/admin/predictionsAnalyticsService');
const catchAsync = require('../../../utils/catchAsync');

/**
 * GET /api/admin/analytics/predictions/dashboard-mini
 * Mini-bilan des résultats pronostics + coupons (modal du dashboard).
 */
exports.getPredictionsDashboardMini = catchAsync(async (req, res) => {
  const data = await predictionsAnalyticsService.getDashboardMini();
  res.status(200).json({ success: true, data });
});
