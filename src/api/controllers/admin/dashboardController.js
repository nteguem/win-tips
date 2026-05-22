/**
 * @fileoverview Contrôleur du tableau de bord admin (vue d'ensemble).
 *
 * Agrège les ventes, les utilisateurs, les abonnements actifs et la
 * performance des pronostics. Toutes les agrégations passent par
 * `Subscription.aggregate` afin de contourner le hook `pre('find')` du modèle
 * Subscription qui masque les abonnements expirés.
 */
const Subscription = require('../../models/common/Subscription');
const User = require('../../models/user/User');
const Package = require('../../models/common/Package');
const Prediction = require('../../models/common/Prediction');
const catchAsync = require('../../../utils/catchAsync');
const { toXAF } = require('../../../utils/currency');

const PERIODS = ['today', '7d', '30d', 'all'];

/** Résout la plage de dates correspondant à une période. */
function resolveRange(period) {
  const end = new Date();
  let start;
  if (period === '7d') {
    start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  } else if (period === '30d') {
    start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  } else if (period === 'all') {
    start = new Date(0);
  } else {
    start = new Date();
    start.setHours(0, 0, 0, 0);
  }
  return { start, end };
}

/** Plage immédiatement antérieure, de même durée (pour calculer les tendances). */
function previousRange(start, end) {
  const span = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - span), end: new Date(start.getTime()) };
}

/** Variation en pourcentage entre une valeur courante et une valeur précédente. */
function trend(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * GET /api/admin/dashboard/stats?period=today|7d|30d|all
 */
exports.getDashboardStats = catchAsync(async (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'today';
  const { start, end } = resolveRange(period);
  const prev = previousRange(start, end);
  const now = new Date();

  // ===== VENTES (abonnements créés dans la période) =====
  const salesAgg = await Subscription.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { provider: '$paymentProvider', currency: '$pricing.currency' },
        count: { $sum: 1 },
        amount: { $sum: '$pricing.amount' },
      },
    },
  ]);

  let salesCount = 0;
  let salesRevenueXAF = 0;
  const providerMap = {};
  const currencyMap = {};
  for (const row of salesAgg) {
    const provider = row._id.provider || 'MOBILE_MONEY';
    const currency = row._id.currency || 'XAF';
    const xaf = toXAF(row.amount, currency);
    salesCount += row.count;
    salesRevenueXAF += xaf;
    if (!providerMap[provider]) providerMap[provider] = { provider, count: 0, revenueXAF: 0 };
    providerMap[provider].count += row.count;
    providerMap[provider].revenueXAF += xaf;
    if (!currencyMap[currency]) currencyMap[currency] = { currency, count: 0, amount: 0, amountXAF: 0 };
    currencyMap[currency].count += row.count;
    currencyMap[currency].amount += row.amount;
    currencyMap[currency].amountXAF += xaf;
  }

  // Ventes de la période précédente (pour la tendance).
  const prevAgg = await Subscription.aggregate([
    { $match: { createdAt: { $gte: prev.start, $lt: prev.end } } },
    { $group: { _id: '$pricing.currency', count: { $sum: 1 }, amount: { $sum: '$pricing.amount' } } },
  ]);
  let prevCount = 0;
  let prevRevenueXAF = 0;
  for (const row of prevAgg) {
    prevCount += row.count;
    prevRevenueXAF += toXAF(row.amount, row._id || 'XAF');
  }

  // ===== COURBE DES 30 DERNIERS JOURS =====
  const chartStart = new Date();
  chartStart.setHours(0, 0, 0, 0);
  chartStart.setDate(chartStart.getDate() - 29);
  const chartAgg = await Subscription.aggregate([
    { $match: { createdAt: { $gte: chartStart } } },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          currency: '$pricing.currency',
        },
        count: { $sum: 1 },
        amount: { $sum: '$pricing.amount' },
      },
    },
  ]);
  const dayMap = {};
  for (const row of chartAgg) {
    const day = row._id.day;
    if (!dayMap[day]) dayMap[day] = { count: 0, revenueXAF: 0 };
    dayMap[day].count += row.count;
    dayMap[day].revenueXAF += toXAF(row.amount, row._id.currency || 'XAF');
  }
  const chart = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(chartStart);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    chart.push({
      date: key,
      count: dayMap[key]?.count || 0,
      revenueXAF: dayMap[key]?.revenueXAF || 0,
    });
  }

  // ===== TOP PACKAGES DE LA PÉRIODE =====
  const pkgAgg = await Subscription.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { pkg: '$package', currency: '$pricing.currency' },
        count: { $sum: 1 },
        amount: { $sum: '$pricing.amount' },
      },
    },
  ]);
  const pkgMap = {};
  for (const row of pkgAgg) {
    const id = String(row._id.pkg);
    if (!pkgMap[id]) pkgMap[id] = { packageId: id, count: 0, revenueXAF: 0 };
    pkgMap[id].count += row.count;
    pkgMap[id].revenueXAF += toXAF(row.amount, row._id.currency || 'XAF');
  }
  const topPackages = Object.values(pkgMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (topPackages.length) {
    const pkgs = await Package.find({ _id: { $in: topPackages.map((p) => p.packageId) } }).select('name');
    const nameMap = {};
    pkgs.forEach((p) => {
      nameMap[String(p._id)] = p.name?.fr || p.name?.en || 'Package';
    });
    topPackages.forEach((p) => {
      p.name = nameMap[p.packageId] || 'Package supprimé';
    });
  }

  // ===== UTILISATEURS =====
  const [totalUsers, newUsers, prevNewUsers, googleUsers] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    User.countDocuments({ createdAt: { $gte: prev.start, $lt: prev.end } }),
    User.countDocuments({ authProvider: 'google' }),
  ]);
  const vipUserIds = await Subscription.distinct('user', { status: 'active', endDate: { $gt: now } });

  // ===== ABONNEMENTS ACTIFS =====
  const activeSubscriptions = await Subscription.countDocuments({
    status: 'active',
    endDate: { $gt: now },
  });

  // ===== PERFORMANCE DES PRONOSTICS (30 derniers jours) =====
  const predAgg = await Prediction.aggregate([
    { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const predCounts = { won: 0, lost: 0, pending: 0, void: 0 };
  for (const row of predAgg) {
    if (predCounts[row._id] !== undefined) predCounts[row._id] = row.count;
  }
  const decided = predCounts.won + predCounts.lost;
  const successRate = decided > 0 ? Math.round((predCounts.won / decided) * 100) : 0;

  res.status(200).json({
    success: true,
    data: {
      period,
      range: { start, end },
      sales: {
        count: salesCount,
        revenueXAF: salesRevenueXAF,
        trend: {
          count: trend(salesCount, prevCount),
          revenueXAF: trend(salesRevenueXAF, prevRevenueXAF),
        },
        byProvider: Object.values(providerMap),
        byCurrency: Object.values(currencyMap),
      },
      users: {
        total: totalUsers,
        newInPeriod: newUsers,
        trend: trend(newUsers, prevNewUsers),
        byAuth: { local: totalUsers - googleUsers, google: googleUsers },
        vip: vipUserIds.length,
      },
      subscriptions: { active: activeSubscriptions },
      predictions: {
        successRate,
        won: predCounts.won,
        lost: predCounts.lost,
        pending: predCounts.pending,
        decided,
      },
      chart,
      topPackages,
    },
  });
});
