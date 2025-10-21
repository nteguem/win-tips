const Category = require('../../models/common/Category');
const Formation = require('../../models/common/Formation');
const subscriptionService = require('../../services/user/subscriptionService');
const { AppError, ErrorCodes } = require('../../../utils/AppError');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Middleware pour vérifier l'accès aux contenus VIP
 * Utilise req.user (défini par userAuth) et categoryId depuis params ou body
 */
exports.checkVipAccess = catchAsync(async (req, res, next) => {
  // Récupérer categoryId depuis les paramètres ou le body
  const categoryId = req.params.categoryId || req.body.categoryId || req.query.categoryId;
  
  if (!categoryId) {
    return next(new AppError('ID de catégorie requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Récupérer la catégorie
  const category = await Category.findById(categoryId);
  if (!category) {
    return next(new AppError('Catégorie non trouvée', 404, ErrorCodes.NOT_FOUND));
  }

  // Si la catégorie est gratuite, autoriser l'accès
  if (!category.isVip) {
    return next();
  }

  // Pour les catégories VIP, vérifier l'abonnement
  if (!req.user) {
    return next(new AppError('Authentification requise pour accéder au contenu VIP', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }

  // Vérifier si l'utilisateur a un abonnement actif pour cette catégorie
  const hasAccess = await subscriptionService.hasAccessToCategory(req.user._id, categoryId);
  
  if (!hasAccess) {
    return next(new AppError('Abonnement VIP requis pour accéder à ce contenu', 403, ErrorCodes.SUBSCRIPTION_REQUIRED));
  }

  // Attacher la catégorie à la requête pour usage ultérieur
  req.category = category;
  next();
});

/**
 * Middleware pour vérifier l'accès aux tickets VIP
 * Utilise le ticket pour récupérer la catégorie
 */
exports.checkTicketAccess = catchAsync(async (req, res, next) => {
  const ticketId = req.params.ticketId || req.params.id;
  
  if (!ticketId) {
    return next(new AppError('ID de ticket requis', 400, ErrorCodes.VALIDATION_ERROR));
  }

  // Récupérer le ticket avec sa catégorie
  const Ticket = require('../../models/common/Ticket');
  const ticket = await Ticket.findById(ticketId).populate('category');
  
  if (!ticket) {
    return next(new AppError('Ticket non trouvé', 404, ErrorCodes.NOT_FOUND));
  }

  // Si la catégorie est gratuite, autoriser l'accès
  if (!ticket.category.isVip) {
    req.ticket = ticket;
    return next();
  }

  // Pour les catégories VIP, vérifier l'abonnement
  if (!req.user) {
    return next(new AppError('Authentification requise pour accéder au contenu VIP', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }

  // Vérifier si l'utilisateur a un abonnement actif pour cette catégorie
  const hasAccess = await subscriptionService.hasAccessToCategory(req.user._id, ticket.category._id);
  
  if (!hasAccess) {
    return next(new AppError('Abonnement VIP requis pour accéder à ce contenu', 403, ErrorCodes.SUBSCRIPTION_REQUIRED));
  }

  // Attacher le ticket à la requête
  req.ticket = ticket;
  next();
});

/**
 * Middleware pour vérifier l'accès VIP pour les coupons
 * Adapté pour le paramètre isVip=true dans la query
 */
exports.checkCouponsVipAccess = catchAsync(async (req, res, next) => {
  const { isVip } = req.query;
  
  // Si on ne demande pas les coupons VIP, pas de vérification nécessaire
  if (isVip !== 'true') {
    return next();
  }

  // Pour les coupons VIP, l'utilisateur doit être authentifié
  if (!req.user) {
    return next(new AppError('Authentification requise pour accéder aux coupons VIP', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }

  // Vérifier si l'utilisateur a au moins un abonnement VIP actif
  const hasVipAccess = await subscriptionService.hasAnyVipAccess(req.user._id);
  
  if (!hasVipAccess) {
    return next(new AppError('Abonnement VIP requis pour accéder aux coupons VIP', 403, ErrorCodes.SUBSCRIPTION_REQUIRED));
  }

  // L'utilisateur a accès aux coupons VIP
  next();
});

/**
 * ✅ NOUVEAU : Middleware pour vérifier l'accès VIP pour les formations
 * Vérifie si la formation nécessite un package VIP (requiredPackages non vide)
 */
exports.checkFormationsVipAccess = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  
  // Récupérer la formation pour vérifier si elle est VIP ou FREE
  const formation = await Formation.findOne({ _id: id, isActive: true });
  
  if (!formation) {
    return next(new AppError('Formation non trouvée', 404, ErrorCodes.NOT_FOUND));
  }
  
  // Si la formation est FREE (requiredPackages vide ou n'existe pas), pas de vérification
  const isFree = !formation.requiredPackages || formation.requiredPackages.length === 0;
  
  if (isFree) {
    // Formation gratuite : accès public
    return next();
  }
  
  // Pour les formations VIP, l'utilisateur doit être authentifié
  if (!req.user) {
    return next(new AppError('Authentification requise pour accéder à ce contenu VIP', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }
  
  // Le controller vérifiera si l'utilisateur a les packages spécifiques requis
  // On laisse passer ici car la vérification détaillée se fait dans le service
  next();
});

/**
 * Middleware optionnel - ne bloque pas mais indique le statut d'accès
 * Utile pour les previews ou contenus partiels
 */
exports.checkVipAccessOptional = catchAsync(async (req, res, next) => {
  const categoryId = req.params.categoryId || req.body.categoryId || req.query.categoryId;
  
  if (!categoryId) {
    req.hasVipAccess = false;
    return next();
  }

  const category = await Category.findById(categoryId);
  if (!category) {
    req.hasVipAccess = false;
    return next();
  }

  // Si gratuite ou pas d'user, pas d'accès VIP
  if (!category.isVip || !req.user) {
    req.hasVipAccess = !category.isVip;
    req.category = category;
    return next();
  }

  // Vérifier l'abonnement
  const hasAccess = await subscriptionService.hasAccessToCategory(req.user._id, categoryId);
  
  req.hasVipAccess = hasAccess;
  req.category = category;
  next();
});

/**
 * Middleware pour empêcher les doubles souscriptions
 * À utiliser avant de créer une nouvelle souscription (Mobile Money ou Google Play)
 */
exports.checkNoActiveSubscription = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('Authentification requise', 401, ErrorCodes.AUTH_TOKEN_MISSING));
  }

  const canSubscribe = await subscriptionService.canSubscribe(req.user._id);
  
  if (!canSubscribe) {
    return next(new AppError('Vous avez déjà un abonnement actif', 400, ErrorCodes.VALIDATION_ERROR));
  }

  next();
});