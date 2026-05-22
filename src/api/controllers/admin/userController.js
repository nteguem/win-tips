/**
 * @fileoverview Contrôleur admin des utilisateurs — alimente la page « Utilisateurs ».
 */
const User = require('../../models/user/User');
const Subscription = require('../../models/common/Subscription');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');
const { toXAF } = require('../../../utils/currency');

// Providers de paiement réels (argent) — exclut les déblocages par pub.
const MONEY_PROVIDERS = ['MOBILE_MONEY', 'GOOGLE_PLAY'];

/** Échappe les métacaractères d'une chaîne pour un usage dans une RegExp. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/admin/users/stats
 * Statistiques de la population d'utilisateurs (ruban de la page).
 */
exports.getUserStats = catchAsync(async (req, res) => {
  const now = new Date();
  const last7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const last30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [total, active, googleUsers, new7, new30, byCountry, vipIds] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    User.countDocuments({ authProvider: 'google' }),
    User.countDocuments({ createdAt: { $gte: last7 } }),
    User.countDocuments({ createdAt: { $gte: last30 } }),
    User.aggregate([
      { $match: { countryCode: { $nin: [null, ''] } } },
      { $group: { _id: '$countryCode', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]),
    Subscription.distinct('user', {
      status: 'active',
      endDate: { $gt: now },
      paymentProvider: { $in: MONEY_PROVIDERS },
    }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      total,
      active,
      inactive: total - active,
      local: total - googleUsers,
      google: googleUsers,
      vip: vipIds.length,
      newLast7Days: new7,
      newLast30Days: new30,
      byCountry: byCountry.map((c) => ({ country: c._id, count: c.count })),
    },
  });
});

/**
 * GET /api/admin/users
 * Liste paginée des utilisateurs avec filtres (recherche, pays, auth, statut,
 * abonnement, plage de dates).
 */
exports.getUsers = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const skip = (page - 1) * limit;
  const now = new Date();

  const match = {};
  const search = (req.query.search || '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    match.$or = [
      { pseudo: rx },
      { firstName: rx },
      { lastName: rx },
      { email: rx },
      { phoneNumber: rx },
    ];
  }
  if (req.query.country) match.countryCode = req.query.country;
  if (['local', 'google'].includes(req.query.authProvider)) match.authProvider = req.query.authProvider;
  if (req.query.isActive === 'true') match.isActive = true;
  if (req.query.isActive === 'false') match.isActive = false;
  if (req.query.startDate || req.query.endDate) {
    match.createdAt = {};
    if (req.query.startDate) match.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) match.createdAt.$lte = new Date(req.query.endDate);
  }

  // Identifiants des utilisateurs VIP : abonnement PAYANT actif (pub exclue).
  // Sert au badge VIP et au filtre par abonnement.
  const vipIds = await Subscription.distinct('user', {
    status: 'active',
    endDate: { $gt: now },
    paymentProvider: { $in: MONEY_PROVIDERS },
  });
  if (req.query.subscription === 'vip') match._id = { $in: vipIds };
  if (req.query.subscription === 'free') match._id = { $nin: vipIds };

  const [users, total] = await Promise.all([
    User.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(match),
  ]);

  const vipSet = new Set(vipIds.map(String));
  const items = users.map((u) => {
    delete u.password;
    delete u.refreshTokens;
    return { ...u, isVip: vipSet.has(String(u._id)) };
  });

  res.status(200).json({
    success: true,
    data: {
      users: items,
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
 * GET /api/admin/users/:id
 * Détail d'un utilisateur avec son historique d'abonnements.
 */
exports.getUser = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.params.id).lean();
  if (!user) return next(new AppError('Utilisateur non trouvé', 404, ErrorCodes.NOT_FOUND));
  delete user.password;
  delete user.refreshTokens;

  // Historique des abonnements via aggregate (inclut les expirés).
  const subs = await Subscription.aggregate([
    { $match: { user: user._id } },
    { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'package' } },
    { $unwind: { path: '$package', preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } },
    {
      $project: {
        status: 1,
        paymentProvider: 1,
        pricing: 1,
        startDate: 1,
        endDate: 1,
        createdAt: 1,
        'package.name': 1,
        'package.duration': 1,
      },
    },
  ]);

  const now = new Date();
  let totalSpentXAF = 0;
  const subscriptions = subs.map((s) => {
    const revenueXAF = toXAF(s.pricing?.amount, s.pricing?.currency);
    totalSpentXAF += revenueXAF;
    return { ...s, revenueXAF };
  });
  const hasActive = subs.some(
    (s) =>
      s.status === 'active' &&
      new Date(s.endDate) > now &&
      MONEY_PROVIDERS.includes(s.paymentProvider)
  );

  res.status(200).json({
    success: true,
    data: {
      user: { ...user, isVip: hasActive },
      subscriptions,
      stats: { subscriptionsCount: subs.length, totalSpentXAF },
    },
  });
});

/**
 * PATCH /api/admin/users/:id/toggle-status
 * Active ou désactive un compte utilisateur.
 */
exports.toggleUserStatus = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.params.id);
  if (!user) return next(new AppError('Utilisateur non trouvé', 404, ErrorCodes.NOT_FOUND));

  user.isActive = !user.isActive;
  await user.save();

  res.status(200).json({
    success: true,
    message: `Utilisateur ${user.isActive ? 'activé' : 'désactivé'} avec succès`,
    data: { user },
  });
});
