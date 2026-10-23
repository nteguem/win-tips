/**
 * @fileoverview Contrôleur admin des abonnements — alimente la page « Ventes ».
 *
 * Utilise systématiquement `Subscription.aggregate` pour la liste et les stats
 * afin d'inclure les abonnements expirés (le hook `pre('find')` du modèle les
 * masquerait sur un `.find()` classique).
 */
const Subscription = require('../../models/common/Subscription');
const catchAsync = require('../../../utils/catchAsync');
const { toXAF } = require('../../../utils/currency');

const PROVIDERS = ['MOBILE_MONEY', 'GOOGLE_PLAY', 'ADS'];
const STATUSES = ['active', 'expired', 'cancelled'];

/** Échappe les métacaractères d'une chaîne pour un usage dans une RegExp. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Construit l'étage `$match` commun (provider, statut, plage de dates). */
function buildMatch(query) {
  const match = {};
  if (PROVIDERS.includes(query.provider)) match.paymentProvider = query.provider;
  if (STATUSES.includes(query.status)) match.status = query.status;
  if (query.startDate || query.endDate) {
    match.createdAt = {};
    if (query.startDate) match.createdAt.$gte = new Date(query.startDate);
    if (query.endDate) match.createdAt.$lte = new Date(query.endDate);
  }
  return match;
}

/**
 * GET /api/admin/subscriptions
 * Liste paginée des abonnements avec filtres et recherche sur l'utilisateur.
 */
exports.getSubscriptions = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const skip = (page - 1) * limit;
  const match = buildMatch(req.query);
  const search = (req.query.search || '').trim();

  const pipeline = [
    { $match: match },
    { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'package' } },
    { $unwind: { path: '$package', preserveNullAndEmptyArrays: true } },
  ];

  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    pipeline.push({
      $match: {
        $or: [
          { 'user.pseudo': rx },
          { 'user.firstName': rx },
          { 'user.lastName': rx },
          { 'user.email': rx },
          { 'user.phoneNumber': rx },
        ],
      },
    });
  }

  pipeline.push(
    { $sort: { createdAt: -1 } },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              status: 1,
              paymentProvider: 1,
              paymentReference: 1,
              pricing: 1,
              startDate: 1,
              endDate: 1,
              createdAt: 1,
              autoRenewing: 1,
              'user._id': 1,
              'user.pseudo': 1,
              'user.firstName': 1,
              'user.lastName': 1,
              'user.email': 1,
              'user.phoneNumber': 1,
              'user.profilePicture': 1,
              'user.countryCode': 1,
              'package._id': 1,
              'package.name': 1,
              'package.duration': 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    }
  );

  const [result] = await Subscription.aggregate(pipeline);
  const items = (result?.data || []).map((s) => ({
    ...s,
    revenueXAF: toXAF(s.pricing?.amount, s.pricing?.currency),
  }));
  const total = result?.total?.[0]?.count || 0;

  res.status(200).json({
    success: true,
    data: {
      subscriptions: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: skip + items.length < total,
      },
    },
  });
});

/**
 * GET /api/admin/subscriptions/stats
 * Statistiques agrégées des ventes (ruban de la page Ventes).
 */
exports.getSubscriptionStats = catchAsync(async (req, res) => {
  const match = buildMatch(req.query);

  const agg = await Subscription.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          provider: '$paymentProvider',
          currency: '$pricing.currency',
          status: '$status',
        },
        count: { $sum: 1 },
        amount: { $sum: '$pricing.amount' },
      },
    },
  ]);

  let totalCount = 0;
  let totalRevenueXAF = 0;
  const byProvider = {};
  const byCurrency = {};
  const byStatus = {};
  for (const row of agg) {
    const provider = row._id.provider || 'MOBILE_MONEY';
    const currency = row._id.currency || 'XAF';
    const status = row._id.status || 'active';
    const xaf = toXAF(row.amount, currency);
    totalCount += row.count;
    totalRevenueXAF += xaf;
    if (!byProvider[provider]) byProvider[provider] = { provider, count: 0, revenueXAF: 0 };
    byProvider[provider].count += row.count;
    byProvider[provider].revenueXAF += xaf;
    if (!byCurrency[currency]) byCurrency[currency] = { currency, count: 0, amount: 0, amountXAF: 0 };
    byCurrency[currency].count += row.count;
    byCurrency[currency].amount += row.amount;
    byCurrency[currency].amountXAF += xaf;
    if (!byStatus[status]) byStatus[status] = { status, count: 0 };
    byStatus[status].count += row.count;
  }

  res.status(200).json({
    success: true,
    data: {
      totalCount,
      totalRevenueXAF,
      byProvider: Object.values(byProvider),
      byCurrency: Object.values(byCurrency),
      byStatus: Object.values(byStatus),
    },
  });
});
