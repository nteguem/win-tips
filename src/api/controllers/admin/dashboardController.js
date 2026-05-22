/**
 * @fileoverview Contrôleur du tableau de bord admin (vue d'ensemble).
 *
 * Règle métier : une « vente » correspond UNIQUEMENT à un abonnement payé
 * en argent (Mobile Money ou Google Play). Les abonnements débloqués via la
 * publicité (paymentProvider='ADS') ne sont PAS comptés comme des ventes.
 *
 * Toutes les agrégations passent par `Subscription.aggregate` afin de
 * contourner le hook `pre('find')` du modèle Subscription qui masque les
 * abonnements expirés.
 */
const Subscription = require('../../models/common/Subscription');
const User = require('../../models/user/User');
const Package = require('../../models/common/Package');
const Prediction = require('../../models/common/Prediction');
const catchAsync = require('../../../utils/catchAsync');
const { toXAF } = require('../../../utils/currency');

const PERIODS = ['today', '7d', '30d', 'all'];

// Providers considérés comme un paiement réel en argent → comptés en ventes.
const MONEY_PROVIDERS = ['MOBILE_MONEY', 'GOOGLE_PLAY'];

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

  // ===== ABONNEMENTS CRÉÉS DANS LA PÉRIODE =====
  // On distingue les ventes (argent) des déblocages par pub (ADS).
  const subsAgg = await Subscription.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { provider: '$paymentProvider', currency: '$pricing.currency' },
        count: { $sum: 1 },
        amount: { $sum: '$pricing.amount' },
      },
    },
  ]);

  let salesCount = 0; // ventes = paiement en argent uniquement
  let salesRevenueXAF = 0;
  let adsCount = 0; // abonnements débloqués par la pub
  const currencyMap = {};
  for (const row of subsAgg) {
    const provider = row._id.provider || 'MOBILE_MONEY';
    const currency = row._id.currency || 'XAF';
    if (provider === 'ADS') {
      adsCount += row.count;
      continue;
    }
    // Vente réelle (argent).
    const xaf = toXAF(row.amount, currency);
    salesCount += row.count;
    salesRevenueXAF += xaf;
    if (!currencyMap[currency]) currencyMap[currency] = { currency, count: 0, amount: 0, amountXAF: 0 };
    currencyMap[currency].count += row.count;
    currencyMap[currency].amount += row.amount;
    currencyMap[currency].amountXAF += xaf;
  }

  // Ventes de la période précédente (argent uniquement) pour la tendance.
  const prevAgg = await Subscription.aggregate([
    {
      $match: {
        createdAt: { $gte: prev.start, $lt: prev.end },
        paymentProvider: { $in: MONEY_PROVIDERS },
      },
    },
    { $group: { _id: '$pricing.currency', count: { $sum: 1 }, amount: { $sum: '$pricing.amount' } } },
  ]);
  let prevCount = 0;
  let prevRevenueXAF = 0;
  for (const row of prevAgg) {
    prevCount += row.count;
    prevRevenueXAF += toXAF(row.amount, row._id || 'XAF');
  }

  // ===== TOP PACKAGES (ventes en argent de la période) =====
  const pkgAgg = await Subscription.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lte: end },
        paymentProvider: { $in: MONEY_PROVIDERS },
      },
    },
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
  // `newInPeriod` = comptes créés pendant la période sélectionnée.
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
        adsCount,
        trend: {
          count: trend(salesCount, prevCount),
          revenueXAF: trend(salesRevenueXAF, prevRevenueXAF),
        },
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
      topPackages,
    },
  });
});
