const Category = require('../../models/common/Category');

class CategoryService {
  
  // Créer une nouvelle catégorie
  async createCategory(data) {
    try {
    const category = new Category(data);
    return await category.save();
    }
    catch(e)
    {
      console.log("error",e)
    }
  }

// Récupérer toutes les catégories avec pagination
async getCategories({ offset = 0, limit = 10, isVip = null, isActive = null }) { // ← CHANGEMENT: isActive = null par défaut
  const filter = {};
  
  // Ne filtrer que si explicitement demandé
  if (isActive !== null) {
    filter.isActive = isActive;
  }
  
  if (isVip !== null) {
    filter.isVip = isVip;
  }

  console.log('Filter applied:', filter); // DEBUG

  const categories = await Category.find(filter)
    .skip(offset)
    .limit(limit)
    .sort({ createdAt: -1 });

  const total = await Category.countDocuments(filter);

  return {
    data: categories,
    pagination: {
      offset,
      limit,
      total,
      hasNext: (offset + limit) < total
    }
  };
}

  // Récupérer une catégorie par ID
  async getCategoryById(id) {
    return await Category.findById(id);
  }

  // Récupérer une catégorie par nom
  async getCategoryByName(name) {
    return await Category.findOne({ name, isActive: true });
  }

  // Mettre à jour une catégorie
  async updateCategory(id, data) {
    return await Category.findByIdAndUpdate(id, data, { new: true });
  }

  // Désactiver une catégorie (soft delete)
  async deactivateCategory(id) {
    return await Category.findByIdAndUpdate(id, { isActive: false }, { new: true });
  }

  // Récupérer les catégories par type (free/vip)
  async getCategoriesByType(isVip, { offset = 0, limit = 10 }) {
    return await this.getCategories({ offset, limit, isVip, isActive: true });
  }

  // Vérifier si une catégorie existe et est active
  async categoryExists(id) {
    const category = await Category.findOne({ _id: id, isActive: true });
    return !!category;
  }
}

module.exports = new CategoryService();