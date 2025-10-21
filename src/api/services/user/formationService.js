const Formation = require('../../models/common/Formation');
const subscriptionService = require('./subscriptionService');

class UserFormationService {

  /**
   * Récupérer toutes les formations avec gestion d'accès selon l'utilisateur
   */
  async getFormationsWithAccess(user = null, options = {}) {
    const { offset = 0, limit = 10, lang = 'fr' } = options;

    // Récupérer toutes les formations actives
    const formations = await Formation.find({ isActive: true })
      .populate('requiredPackages', 'name description pricing duration badge economy')
      .skip(offset)
      .limit(limit)
      .sort({ order: 1, createdAt: -1 }); 


    const total = await Formation.countDocuments({ isActive: true });

    // Récupérer les packages actifs de l'utilisateur s'il est connecté
    let userPackages = [];
    if (user) {
      const subscriptions = await subscriptionService.getActiveSubscriptions(user._id);
      userPackages = subscriptions.map(sub => sub.package._id.toString());
    }

    // Formater les formations selon l'accès
    const formattedFormations = formations.map(formation => {
      return this.formatFormationWithAccess(formation, userPackages, lang);
    });

    return {
      data: formattedFormations,
      pagination: {
        total,
        offset,
        limit,
        hasMore: offset + limit < total
      }
    };
  }

  /**
   * Récupérer une formation par ID avec gestion d'accès
   */
  async getFormationByIdWithAccess(id, user = null, lang = 'fr') {
    const formation = await Formation.findOne({ _id: id, isActive: true })
      .populate('requiredPackages', 'name description pricing duration badge economy');
    
    if (!formation) {
      return null;
    }

    // Récupérer les packages actifs de l'utilisateur
    let userPackages = [];
    if (user) {
      const subscriptions = await subscriptionService.getActiveSubscriptions(user._id);
      userPackages = subscriptions.map(sub => sub.package._id.toString());
    }

    return this.formatFormationWithAccess(formation, userPackages, lang);
  }

  /**
   * ✅ CORRIGÉ : Récupérer le contenu d'une formation avec vérification d'accès
   * Utilisé pour l'endpoint GET /formations/:id/content
   */
  async getFormationContentWithAccess(id, user = null, lang = 'fr') {
    const formation = await Formation.findOne({ _id: id, isActive: true })
      .populate('requiredPackages', 'name description pricing duration badge economy');
    
    if (!formation) {
      return null;
    }

    // Données de base (toujours renvoyées)
    const baseFormat = {
      _id: formation._id,
      title: formation.title[lang] || formation.title.fr,
      description: formation.description[lang] || formation.description.fr,
      imageUrl: formation.imageUrl || null,
      readingTime: formation.readingTime || null,
      createdAt: formation.createdAt,
      updatedAt: formation.updatedAt
    };

    // ✅ LOGIQUE CORRIGÉE : Formation gratuite si requiredPackages est vide
    const isFree = !formation.requiredPackages || formation.requiredPackages.length === 0;

    if (isFree) {
      // Formation gratuite : renvoyer le htmlContent directement
      return {
        ...baseFormat,
        htmlContent: formation.htmlContent[lang] || formation.htmlContent.fr,
        hasAccess: true,
        isFree: true
      };
    }

    // Formation payante : vérifier si l'utilisateur a accès
    let userPackages = [];
    if (user) {
      const subscriptions = await subscriptionService.getActiveSubscriptions(user._id);
      userPackages = subscriptions.map(sub => sub.package._id.toString());
    }

    const hasAccess = formation.requiredPackages.some(pkg => 
      userPackages.includes(pkg._id.toString())
    );

    if (hasAccess) {
      // Utilisateur a accès : renvoyer le htmlContent
      return {
        ...baseFormat,
        htmlContent: formation.htmlContent[lang] || formation.htmlContent.fr,
        hasAccess: true,
        isFree: false
      };
    } else {
      // Utilisateur n'a pas accès : renvoyer les packages requis (sans htmlContent)
      return {
        ...baseFormat,
        hasAccess: false,
        isFree: false,
        requiredPackages: formation.requiredPackages.map(pkg => ({
          _id: pkg._id,
          name: pkg.name[lang] || pkg.name.fr,
          description: pkg.description ? (pkg.description[lang] || pkg.description.fr) : null,
          pricing: Object.fromEntries(pkg.pricing),
          duration: pkg.duration,
          badge: pkg.badge ? (pkg.badge[lang] || pkg.badge.fr) : null,
          economy: pkg.economy ? Object.fromEntries(pkg.economy) : null
        }))
      };
    }
  }

  /**
   * Formater une formation selon l'accès de l'utilisateur
   */
  formatFormationWithAccess(formation, userPackages = [], lang = 'fr') {
    const baseFormat = {
      _id: formation._id,
      title: formation.title[lang] || formation.title.fr,
      description: formation.description[lang] || formation.description.fr,
      imageUrl: formation.imageUrl || null,
      readingTime: formation.readingTime || null,
      createdAt: formation.createdAt,
      updatedAt: formation.updatedAt
    };

    // ✅ LOGIQUE CORRIGÉE : Formation gratuite si requiredPackages est vide
    const isFree = !formation.requiredPackages || formation.requiredPackages.length === 0;

    if (isFree) {
      // Formation gratuite : renvoyer le htmlContent directement
      return {
        ...baseFormat,
        htmlContent: formation.htmlContent[lang] || formation.htmlContent.fr,
        hasAccess: true,
        isFree: true
      };
    }

    // Formation payante : vérifier si l'utilisateur a accès
    const hasAccess = formation.requiredPackages.some(pkg => 
      userPackages.includes(pkg._id.toString())
    );

    if (hasAccess) {
      // Utilisateur a accès : renvoyer le htmlContent
      return {
        ...baseFormat,
        htmlContent: formation.htmlContent[lang] || formation.htmlContent.fr,
        hasAccess: true,
        isFree: false
      };
    } else {
      // Utilisateur n'a pas accès : renvoyer les packages requis
      return {
        ...baseFormat,
        hasAccess: false,
        isFree: false,
        requiredPackages: formation.requiredPackages.map(pkg => ({
          _id: pkg._id,
          name: pkg.name[lang] || pkg.name.fr,
          description: pkg.description ? (pkg.description[lang] || pkg.description.fr) : null,
          pricing: Object.fromEntries(pkg.pricing),
          duration: pkg.duration,
          badge: pkg.badge ? (pkg.badge[lang] || pkg.badge.fr) : null,
          economy: pkg.economy ? Object.fromEntries(pkg.economy) : null
        }))
      };
    }
  }
}

module.exports = new UserFormationService();