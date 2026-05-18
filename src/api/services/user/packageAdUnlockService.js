// src/api/services/user/packageAdUnlockService.js
//
// Gère le "paiement" d'un Package par visionnage de pubs récompensées,
// pour les packs configurés en `paymentMode: 'ads'`.
//
// Flow :
//   1. start(userId, packageId)
//      → crée/réinitialise UserAccessUnlock (resourceType='package_unlock',
//        resource=packageId), génère un nonce frais.
//      → renvoie { nonce, adsRequired, adsWatched, completed }
//      → le client transmet `nonce` dans le `customData` des pubs récompensées.
//
//   2. (asynchrone) callback SSV AdMob arrive sur le admobSsvController, qui
//      appelle accessGateService.recordVerifiedReward({ nonce, ... }). Comme
//      `recordVerifiedReward` travaille uniquement par nonce, il marche pour
//      n'importe quel resourceType sans modification.
//      → atomique + idempotent (dédup sur transactionId)
//      → quand verifiedCount >= adsRequired → status='unlocked', unlockedAt=now
//
//   3. getProgress(userId, packageId) → state actuel
//      → si status='unlocked' ET pas de Subscription liée encore →
//        finalize() crée la Subscription pour la durée du pack et lie le
//        UserAccessUnlock à la Subscription (via paymentReference = unlock._id).
//
// Idempotence : start() peut être rappelé tant que pas 'unlocked' (régénère le
// nonce). Une fois unlocked, on conserve l'état et finalize() ne crée pas
// 2 Subscriptions (check unicité par UserAccessUnlock._id).

const crypto = require('crypto');
const UserAccessUnlock = require('../../models/common/UserAccessUnlock');
const Package = require('../../models/common/Package');
const Subscription = require('../../models/common/Subscription');
const subscriptionService = require('./subscriptionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

const RESOURCE_TYPE_PACKAGE = 'package_unlock';

/**
 * Construit la vue API exposée au client.
 * `subscriptionCreated` est passé en paramètre (calculé en amont) pour rester
 * pur (pas de DB call ici).
 */
function buildView(doc, pkg, subscriptionCreated = false) {
  const adsRequired = (doc?.selectedOption?.adsRequired) ?? (pkg?.adsRequired) ?? 0;
  const adsWatched = Math.min(doc?.verifiedCount ?? 0, adsRequired || Number.MAX_SAFE_INTEGER);
  const completed = !!(doc && doc.status === 'unlocked');
  return {
    packageId: pkg?._id || null,
    paymentMode: pkg?.paymentMode || 'money',
    adsRequired,
    adsWatched,
    completed,
    eligible: completed,
    percentage: adsRequired > 0 ? Math.round((adsWatched / adsRequired) * 1000) / 10 : 0,
    nonce: doc?.nonce || null,
    subscriptionCreated,
  };
}

/**
 * Cherche le Package + valide qu'il est en mode 'ads'.
 */
async function getAdPackOrThrow(packageId) {
  const pkg = await Package.findById(packageId);
  if (!pkg || !pkg.isActive) {
    throw new AppError('Package non trouvé ou inactif.', 404, ErrorCodes.NOT_FOUND);
  }
  if (pkg.paymentMode !== 'ads') {
    throw new AppError(
      'Ce package n\'est pas débloquable par publicité.',
      400,
      ErrorCodes.OPERATION_NOT_ALLOWED
    );
  }
  if (!pkg.adsRequired || pkg.adsRequired < 1) {
    throw new AppError(
      'Configuration adsRequired invalide pour ce package.',
      500,
      ErrorCodes.VALIDATION_ERROR
    );
  }
  return pkg;
}

/**
 * État courant pour le client. Si la porte est passée mais la Subscription
 * pas encore créée → on la crée maintenant (finalize). Idempotent.
 *
 * @returns Vue API + sub (subscription) si déjà créée
 */
async function getProgress(userId, packageId) {
  const pkg = await getAdPackOrThrow(packageId);

  let doc = await UserAccessUnlock.findOne({
    user: userId,
    resourceType: RESOURCE_TYPE_PACKAGE,
    resource: pkg._id,
  });

  // Finalize si seuil atteint et sub pas encore créée
  let subscription = null;
  if (doc && doc.status === 'unlocked') {
    subscription = await ensureSubscription(doc, pkg, userId);
  }

  const view = buildView(doc, pkg, !!subscription);
  return { ...view, subscription };
}

/**
 * Démarre (ou rafraîchit) la session ad-unlock du pack.
 *  - Si user a déjà un Sub actif sur ce pack → 409
 *  - Si déjà unlocked → idempotent, on renvoie l'état + crée la Sub si manquante
 *  - Sinon → crée/réinit le doc avec nonce frais
 */
async function start(userId, packageId) {
  const pkg = await getAdPackOrThrow(packageId);

  // 0. Refuse si l'user a déjà un Subscription ACTIF sur ce pack
  const activeSub = await Subscription.findOne({
    user: userId,
    package: pkg._id,
    status: 'active',
    endDate: { $gt: new Date() },
  }).lean();
  if (activeSub) {
    throw new AppError(
      'Tu as déjà un abonnement actif sur ce package.',
      409,
      ErrorCodes.OPERATION_NOT_ALLOWED
    );
  }

  let doc = await UserAccessUnlock.findOne({
    user: userId,
    resourceType: RESOURCE_TYPE_PACKAGE,
    resource: pkg._id,
  });

  // Cas 1 : déjà unlocked (cycle précédent) ET pas de sub active
  //   → on respecte la sémantique d'expiration : on RESET pour qu'il puisse
  //     refaire un cycle. Ses anciennes pubs ne comptent pas (cycle nouveau).
  if (doc && doc.status === 'unlocked') {
    doc.status = 'in_progress';
    doc.verifiedCount = 0;
    doc.rewards = [];
    doc.unlockedAt = null;
    doc.expiresAt = null;
  }

  if (!doc) {
    doc = new UserAccessUnlock({
      user: userId,
      resourceType: RESOURCE_TYPE_PACKAGE,
      resource: pkg._id,
    });
  }

  doc.selectedOption = {
    durationMinutes: null, // on ne mesure pas l'expiration ici — c'est la Sub qui porte la durée
    adsRequired: pkg.adsRequired,
  };
  doc.nonce = crypto.randomBytes(24).toString('hex');
  doc.status = 'in_progress';
  if (!doc.verifiedCount) doc.verifiedCount = 0;

  await doc.save();
  return buildView(doc, pkg);
}

/**
 * Crée la Subscription pour ce pack si pas déjà créée pour cet unlock.
 * Idempotent : on cherche d'abord une Subscription avec
 * paymentReference=`ads:${doc._id}`. Si existe → on la retourne sans rien
 * faire. Sinon → on crée.
 *
 * Si la sub existante a expiré (endDate < now), on ne crée PAS une nouvelle
 * sub depuis ici — l'appelant doit appeler start() pour relancer un cycle.
 */
async function ensureSubscription(doc, pkg, userId) {
  const ref = `ads:${doc._id.toString()}`;

  // 1. Idempotence : sub déjà créée pour cet unlock ?
  const existing = await Subscription.findOne({ paymentReference: ref });
  if (existing) return existing;

  // 2. Création de la sub
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + pkg.duration * 24 * 60 * 60 * 1000);

  const sub = await Subscription.create({
    user: userId,
    package: pkg._id,
    startDate,
    endDate,
    pricing: { amount: 0, currency: 'XAF' }, // placeholder pour conformité schema
    status: 'active',
    paymentProvider: 'ADS',
    paymentReference: ref,
  });

  // 3. Commission éventuelle si l'user a un parrain
  try {
    const User = require('../../models/user/User');
    const commissionService = require('../common/commissionService');
    const user = await User.findById(userId).lean();
    if (user && user.referredBy) {
      await commissionService.createCommission(sub._id);
    }
  } catch (e) {
    // Non bloquant — on log et on continue
    console.warn('[packageAdUnlockService] Commission création échouée:', e.message);
  }

  return sub;
}

module.exports = {
  RESOURCE_TYPE_PACKAGE,
  getProgress,
  start,
  ensureSubscription,
};
