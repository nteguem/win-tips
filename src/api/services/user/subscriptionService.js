const Subscription = require('../../models/common/Subscription');
const Package = require('../../models/common/Package');
const User = require('../../models/user/User');
const Category = require('../../models/common/Category');
const GooglePlayTransaction = require('../../models/user/GooglePlayTransaction');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const crypto = require('node:crypto');

function referenceId(value) {
  return value == null ? null : String(value._id || value);
}

function purchasedPackage(subscription) {
  const snapshot = subscription.paymentSnapshot;
  if (!snapshot) return subscription.package;
  return {
    _id: snapshot.packageId || subscription.package?._id || subscription.package,
    name: snapshot.packageName,
    description: snapshot.packageDescription,
    type: snapshot.packageType,
    duration: snapshot.packageDuration,
    categories: snapshot.packageCouponTypes || [],
    formationId: snapshot.formationId
  };
}

class SubscriptionService {
  /**
   * Créer un abonnement pour un utilisateur (Mobile Money)
   */
  async createSubscription(userId, packageId, currency, paymentReference = null, options = {}) {
    const reference = referenceId(paymentReference);
    const userReference = referenceId(userId);
    const packageReference = referenceId(packageId);
    const normalizedCurrency = String(currency || '').toUpperCase();
    const paymentKey = reference ? `mobile-money:${options.providerKey || 'legacy'}:${reference}` : null;
    // Reuse historical subscriptions as well as new ones. A replay must not
    // extend the entitlement, even after it has expired or been cancelled.
    if (reference) {
      const existing = await Subscription.findOne({ paymentKey }) || await Subscription.findOne({
        paymentReference: reference, paymentProvider: 'MOBILE_MONEY', paymentKey: { $exists: false }
      });
      if (existing) {
        if (referenceId(existing.user) !== userReference || referenceId(existing.package) !== packageReference) {
          throw new AppError('Référence de paiement incohérente', 409, ErrorCodes.VALIDATION_ERROR);
        }
        return existing;
      }
    }

    // Checkout validates availability. A settled payment must still deliver
    // the package bought before the operator disabled it or edited its price.
    const packageNew = await Package.findById(packageId);
    const storedSnapshot = options.confirmedPayment && options.paymentSnapshot;
    if ((!packageNew && !storedSnapshot) || (!options.confirmedPayment && !packageNew.isActive)) {
      throw new AppError('Package non disponible', 404, ErrorCodes.NOT_FOUND);
    }

    // Vérifier que le prix existe pour la devise
    const price = storedSnapshot ? Number(storedSnapshot.amount)
      : options.confirmedPayment && options.amount != null ? Number(options.amount)
        : Number(packageNew.pricing?.get(normalizedCurrency));
    const duration = Number(storedSnapshot ? storedSnapshot.packageDuration : packageNew.duration);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(duration) || duration < 1 ||
        (storedSnapshot && (String(storedSnapshot.currency).toUpperCase() !== normalizedCurrency ||
          (options.amount != null && Number(options.amount) !== price) ||
          (storedSnapshot.durationUnit && storedSnapshot.durationUnit !== 'days') ||
          (storedSnapshot.packageId && referenceId(storedSnapshot.packageId) !== packageReference)))) {
      throw new AppError(`Prix non disponible en ${currency}`, 400, ErrorCodes.VALIDATION_ERROR);
    }
    
    // Récupérer l'utilisateur
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('Utilisateur non trouvé', 404, ErrorCodes.NOT_FOUND);
    }

    // Calculer les dates
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + duration * 24 * 60 * 60 * 1000);
    const snapshot = storedSnapshot || (options.confirmedPayment ? {
      packageId: packageReference,
      packageName: packageNew.name,
      packageDescription: packageNew.description,
      packageType: packageNew.type,
      packageDuration: duration,
      durationUnit: 'days',
      packageCouponTypes: (packageNew.categories || []).map(referenceId),
      formationId: packageNew.formationId,
      amount: price,
      currency: normalizedCurrency
    } : undefined);

    // Créer l'abonnement
    const values = {
      user: userId,
      package: packageId,
      startDate,
      endDate,
      pricing: {
        amount: price,
        currency: normalizedCurrency
      },
      paymentReference: reference,
      paymentProvider: 'MOBILE_MONEY',
      ...(snapshot ? { paymentSnapshot: snapshot } : {})
    };
    if (!reference) return Subscription.create(values);

    const stableId = crypto.createHash('sha256').update(paymentKey).digest('hex').slice(0, 24);
    let subscription;
    try {
      // MongoDB's built-in unique _id serializes concurrent webhook, polling
      // and cron upserts. A crash after this write is repaired by the next run.
      subscription = await Subscription.findOneAndUpdate(
        { _id: stableId },
        { $setOnInsert: { ...values, paymentKey } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      subscription = await Subscription.findOne({ _id: stableId });
      if (!subscription) throw error;
    }

    return subscription;
  }

  /**
   * NOUVELLE : Créer un abonnement Google Play
   */
  async createGooglePlaySubscription(userId, packageId, googleTransactionId, purchaseData) {
    // Vérifier que le package existe
    const packageNew = await Package.findById(packageId);
    if (!packageNew || !packageNew.isActive) {
      throw new AppError('Package non disponible', 404, ErrorCodes.NOT_FOUND);
    }

    // Récupérer l'utilisateur
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('Utilisateur non trouvé', 404, ErrorCodes.NOT_FOUND);
    }

    // Créer l'abonnement
    const subscription = await Subscription.create({
      user: userId,
      package: packageId,
      startDate: purchaseData.startDate,
      endDate: purchaseData.endDate,
      pricing: {
        amount: purchaseData.amount,
        currency: purchaseData.currency
      },
      status: 'active',
      paymentProvider: 'GOOGLE_PLAY',
      paymentReference: purchaseData.orderId,
      googlePlayTransaction: googleTransactionId,
      autoRenewing: purchaseData.autoRenewing
    });

    return subscription;
  }

  /**
   * Obtenir les informations complètes d'abonnement d'un utilisateur.
   *
   * Note : on filtre les souscriptions dont le package a été supprimé en BD
   * (populate('package') renvoie alors null). Sans ce filtre, l'accès
   * `subscription.package._id` provoquait un crash sur tous les endpoints
   * qui appellent getUserSubscriptionInfo (login, /me, register, refresh).
   */
  async getUserSubscriptionInfo(userId) {
    const activeSubscriptions = await this.getActiveSubscriptions(userId);

    const validSubscriptions = activeSubscriptions.filter(sub => purchasedPackage(sub));
    if (validSubscriptions.length !== activeSubscriptions.length) {
      console.warn(
        `[SubscriptionService] User ${userId} : ${activeSubscriptions.length - validSubscriptions.length} souscription(s) orpheline(s) ignorée(s) (package supprimé)`
      );
    }

    const activePackages = validSubscriptions.map(subscription => ({
      id: purchasedPackage(subscription)._id,
      name: purchasedPackage(subscription).name,
      description: purchasedPackage(subscription).description,
      type: purchasedPackage(subscription).type,
      duration: purchasedPackage(subscription).duration,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      status: subscription.status,
      pricing: {
        amount: subscription.pricing.amount,
        currency: subscription.pricing.currency
      },
      categories: purchasedPackage(subscription).categories || [],
      subscriptionId: subscription._id,
      paymentProvider: subscription.paymentProvider,
      autoRenewing: subscription.autoRenewing || false
    }));

    return {
      hasActiveSubscription: validSubscriptions.length > 0,
      activePackages,
      totalActiveSubscriptions: validSubscriptions.length
    };
  }

  /**
   * MODIFIÉE : Obtenir les abonnements actifs d'un utilisateur (Mobile Money + Google Play)
   */
  async getActiveSubscriptions(userId) {
    return await Subscription.find({
      user: userId,
      status: 'active',
      $or: [
        // Tous les abonnements qui ne sont PAS Google Play (inclut ceux sans paymentProvider)
        {
          $or: [
            { paymentProvider: { $exists: false } },
            { paymentProvider: { $ne: 'GOOGLE_PLAY' } }
          ],
          endDate: { $gt: new Date() }
        },
        // Google Play
        {
          paymentProvider: 'GOOGLE_PLAY'
        }
      ]
    }).populate('package');
  }

  /**
   * Vérifier si un utilisateur a accès à une catégorie
   * Note: Ne vérifie PLUS isActive - les utilisateurs gardent l'accès même si le package n'est plus achetable
   */
  async hasAccessToCategory(userId, categoryId) {
    const activeSubscriptions = await this.getActiveSubscriptions(userId);
    
    for (const subscription of activeSubscriptions) {
      if (subscription.paymentSnapshot) {
        if ((subscription.paymentSnapshot.packageCouponTypes || []).some(id => referenceId(id) === referenceId(categoryId))) return true;
        continue;
      }
      // Récupérer le package ACTUEL avec ses catégories ACTUELLES
      // Protection : sub.package peut être null (package supprimé) ou un
      // ObjectId brut (non populé). On extrait l'id de façon sûre.
      const pkgRef = subscription.package;
      if (!pkgRef) continue;
      const pkgId = pkgRef._id || pkgRef;
      const currentPackage = await Package.findById(pkgId);
      
      // Vérifie uniquement que le package existe et contient la catégorie
      // Plus de vérification isActive - l'utilisateur garde l'accès qu'il a payé
      if (currentPackage && currentPackage.categories.some(id => referenceId(id) === referenceId(categoryId))) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Vérifier si un utilisateur a accès à au moins une catégorie VIP
   * Note: Ne vérifie PLUS isActive - les utilisateurs gardent l'accès même si le package n'est plus achetable
   */
  async hasAnyVipAccess(userId) {
    // Récupérer les abonnements actifs de l'utilisateur
    const activeSubscriptions = await this.getActiveSubscriptions(userId);
    
    if (activeSubscriptions.length === 0) {
      return false;
    }

    // Récupérer les catégories ACTUELLES de chaque package
    const categoryIds = [];
    for (const subscription of activeSubscriptions) {
      if (subscription.paymentSnapshot) {
        categoryIds.push(...(subscription.paymentSnapshot.packageCouponTypes || []));
        continue;
      }
      // Récupérer le package ACTUEL (pas celui stocké dans l'abonnement)
      // Protection : sub.package peut être null (package supprimé) ou un
      // ObjectId brut (non populé). On extrait l'id de façon sûre.
      const pkgRef = subscription.package;
      if (!pkgRef) continue;
      const pkgId = pkgRef._id || pkgRef;
      const currentPackage = await Package.findById(pkgId);
      
      // Plus de vérification isActive - l'utilisateur garde l'accès qu'il a payé
      if (currentPackage) {
        categoryIds.push(...currentPackage.categories);
      }
    }

    // Supprimer les doublons
    const uniqueCategoryIds = [...new Set(categoryIds.map(id => id.toString()))];

    if (uniqueCategoryIds.length === 0) {
      return false;
    }

    // Vérifier si au moins une de ces catégories est VIP
    const vipCategories = await Category.find({
      _id: { $in: uniqueCategoryIds },
      isVip: true,
      isActive: true
    });

    return vipCategories.length > 0;
  }

  /**
   * Obtenir toutes les catégories VIP auxquelles l'utilisateur a accès
   * Note: Ne vérifie PLUS isActive - les utilisateurs gardent l'accès même si le package n'est plus achetable
   */
  async getUserVipCategories(userId) {
    const activeSubscriptions = await this.getActiveSubscriptions(userId);
    
    if (activeSubscriptions.length === 0) {
      return [];
    }

    // Récupérer les catégories ACTUELLES de chaque package
    const categoryIds = [];
    for (const subscription of activeSubscriptions) {
      if (subscription.paymentSnapshot) {
        categoryIds.push(...(subscription.paymentSnapshot.packageCouponTypes || []));
        continue;
      }
      // Récupérer le package ACTUEL (pas celui stocké dans l'abonnement)
      // Protection : sub.package peut être null (package supprimé) ou un
      // ObjectId brut (non populé). On extrait l'id de façon sûre.
      const pkgRef = subscription.package;
      if (!pkgRef) continue;
      const pkgId = pkgRef._id || pkgRef;
      const currentPackage = await Package.findById(pkgId);
      
      // Plus de vérification isActive - l'utilisateur garde l'accès qu'il a payé
      if (currentPackage) {
        categoryIds.push(...currentPackage.categories);
      }
    }

    // Supprimer les doublons
    const uniqueCategoryIds = [...new Set(categoryIds.map(id => id.toString()))];

    if (uniqueCategoryIds.length === 0) {
      return [];
    }

    // Récupérer toutes les catégories VIP auxquelles l'utilisateur a accès
    return await Category.find({
      _id: { $in: uniqueCategoryIds },
      isVip: true,
      isActive: true
    });
  }

  /**
   * Obtenir tous les abonnements d'un utilisateur
   */
  async getUserSubscriptions(userId) {
    return await Subscription.find({ user: userId })
      .populate('package')
      .sort({ createdAt: -1 });
  }

  /**
   * MODIFIÉE : Annuler un abonnement
   */
  async cancelSubscription(subscriptionId, userId) {
    const subscription = await Subscription.findOne({
      _id: subscriptionId,
      user: userId
    });

    if (!subscription) {
      throw new AppError('Abonnement non trouvé', 404, ErrorCodes.NOT_FOUND);
    }

    if (subscription.status !== 'active') {
      throw new AppError('Seuls les abonnements actifs peuvent être annulés', 400, ErrorCodes.VALIDATION_ERROR);
    }

    // Pour Google Play, on ne peut pas annuler depuis notre backend
    if (subscription.paymentProvider === 'GOOGLE_PLAY') {
      throw new AppError('Les abonnements Google Play doivent être annulés depuis Google Play Store', 400, ErrorCodes.VALIDATION_ERROR);
    }

    // Annuler l'abonnement Mobile Money
    await subscription.cancel();

    return subscription;
  }

  /**
   * Obtenir les statistiques des abonnements
   */
  async getSubscriptionStats() {
    const stats = await Subscription.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$pricing.amount' }
        }
      }
    ]);

    return stats;
  }

  /**
   * NOUVELLE : Vérifier si un utilisateur peut souscrire
   */
  async canSubscribe(userId) {
    const activeSubscription = await Subscription.findOne({
      user: userId,
      status: 'active',
      $or: [
        {
          paymentProvider: 'MOBILE_MONEY',
          endDate: { $gt: new Date() }
        },
        {
          paymentProvider: 'GOOGLE_PLAY'
        }
      ]
    });
    
    return !activeSubscription;
  }

  /**
   * NOUVELLE : Obtenir le type de provider d'un abonnement actif
   */
  async getActiveSubscriptionProvider(userId) {
    const subscription = await Subscription.findOne({
      user: userId,
      status: 'active',
      $or: [
        {
          paymentProvider: 'MOBILE_MONEY',
          endDate: { $gt: new Date() }
        },
        {
          paymentProvider: 'GOOGLE_PLAY'
        }
      ]
    });

    return subscription ? subscription.paymentProvider : null;
  }

  /**
   * ✅ NOUVELLE : Vérifier si l'utilisateur a accès à une formation
   * @param {string} userId - ID de l'utilisateur
   * @param {Array} requiredPackages - Liste des IDs de packages requis pour la formation
   * @returns {boolean} - True si l'utilisateur a accès, false sinon
   */
  async hasAccessToFormation(userId, requiredPackages) {
    // Si pas de packages requis ou tableau vide, la formation est gratuite
    if (!requiredPackages || requiredPackages.length === 0) {
      return true;
    }

    // Récupérer les abonnements actifs de l'utilisateur
    const activeSubscriptions = await this.getActiveSubscriptions(userId);

    if (activeSubscriptions.length === 0) {
      return false;
    }

    // Vérifier si l'utilisateur a au moins un abonnement actif
    // correspondant à un des packages requis
    for (const subscription of activeSubscriptions) {
      // Protection : sub.package peut être null (package supprimé).
      const pkgRef = subscription.paymentSnapshot?.packageId || subscription.package;
      if (!pkgRef) continue;
      const pkgId = (pkgRef._id || pkgRef).toString();
      const hasRequiredPackage = requiredPackages.some(
        packageId => packageId.toString() === pkgId
      );

      if (hasRequiredPackage) {
        return true;
      }
    }

    return false;
  }
}

module.exports = new SubscriptionService();
