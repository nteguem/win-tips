const Formation = require('../../models/common/Formation');

class FormationService {

  // Récupérer toutes les formations avec pagination
  async getFormations(options = {}) {
    const { offset = 0, limit = 10, isActive = null, lang = 'fr' } = options;

    // Construire le filtre
    const filter = {};
    if (isActive !== null) {
      filter.isActive = isActive;
    }

    // Récupérer les formations avec pagination et populate des packages
    const formations = await Formation.find(filter)
      .populate('requiredPackages', 'name description pricing duration badge economy')
      .skip(offset)
      .limit(limit)
      .sort({ order: 1, createdAt: -1 });

    // Compter le total pour la pagination
    const total = await Formation.countDocuments(filter);

    // Formater selon la langue
    const formattedFormations = formations.map(formation => this.formatFormation(formation, lang));

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

  // Récupérer une formation par ID
  async getFormationById(id, lang = 'fr') {
    const formation = await Formation.findById(id)
      .populate('requiredPackages', 'name description pricing duration badge economy');
    
    if (!formation) {
      return null;
    }

    return this.formatFormation(formation, lang);
  }

  // Créer une nouvelle formation
  async createFormation(formationData) {
    const formation = await Formation.create(formationData);
    // Populate après création pour retourner les données complètes
    return await Formation.findById(formation._id)
      .populate('requiredPackages', 'name description pricing duration badge economy');
  }

  // Mettre à jour une formation
  async updateFormation(id, updates) {
    const formation = await Formation.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true
    }).populate('requiredPackages', 'name description pricing duration badge economy');

    return formation;
  }

  // Désactiver une formation
  async deactivateFormation(id) {
    const formation = await Formation.findByIdAndUpdate(
      id, 
      { isActive: false }, 
      { new: true }
    ).populate('requiredPackages', 'name description pricing duration badge economy');

    return formation;
  }

  // Activer une formation
  async activateFormation(id) {
    const formation = await Formation.findByIdAndUpdate(
      id, 
      { isActive: true }, 
      { new: true }
    ).populate('requiredPackages', 'name description pricing duration badge economy');

    return formation;
  }

  // Méthode utilitaire pour formater une formation selon la langue
  formatFormation(formation, lang = 'fr') {
    return {
      _id: formation._id,
      title: formation.title[lang] || formation.title.fr,
      description: formation.description[lang] || formation.description.fr,
      htmlContent: formation.htmlContent[lang] || formation.htmlContent.fr,
      isAccessible: formation.isAccessible,
      requiredPackages: formation.requiredPackages ? formation.requiredPackages.map(pkg => ({
        _id: pkg._id,
        name: pkg.name[lang] || pkg.name.fr,
        description: pkg.description ? (pkg.description[lang] || pkg.description.fr) : null,
        pricing: Object.fromEntries(pkg.pricing),
        duration: pkg.duration,
        badge: pkg.badge ? (pkg.badge[lang] || pkg.badge.fr) : null,
        economy: pkg.economy ? Object.fromEntries(pkg.economy) : null
      })) : [],
      isActive: formation.isActive,
      createdAt: formation.createdAt,
      updatedAt: formation.updatedAt
    };
  }

  // Récupérer toutes les formations actives (pour les packages)
  async getActiveFormations(lang = 'fr') {
    const formations = await Formation.find({ isActive: true })
      .populate('requiredPackages', 'name description pricing duration badge economy');
    return formations.map(formation => this.formatFormation(formation, lang));
  }
}

module.exports = new FormationService();