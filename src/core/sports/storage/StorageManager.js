/**
 * Classe abstraite pour les gestionnaires de stockage
 * @abstract
 */
class StorageManager {
  /**
   * Crée une instance de StorageManager
   * @param {Object} dependencies - Dépendances injectées
   * @param {Object} dependencies.logger - Logger
   */
  constructor({ logger }) {
    if (this.constructor === StorageManager) {
      throw new Error('StorageManager is an abstract class and cannot be instantiated directly');
    }
    
    this.logger = logger;
  }
  
  /**
   * Sauvegarde des données
   * @abstract
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @param {Object} data - Données à sauvegarder
   * @returns {Promise<boolean>} - Statut de la sauvegarde
   */
  async saveData(sport, date, data) {
    throw new Error('Method saveData must be implemented');
  }
  
  /**
   * Récupère des données
   * @abstract
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @returns {Promise<Object>} - Données récupérées
   */
  async getData(sport, date) {
    throw new Error('Method getData must be implemented');
  }
  
  /**
   * Vérifie si des données existent
   * @abstract
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @returns {Promise<boolean>} - True si les données existent
   */
  async dataExists(sport, date) {
    throw new Error('Method dataExists must be implemented');
  }
  
  /**
   * Récupère les dates disponibles
   * @abstract
   * @param {string} sport - Type de sport
   * @returns {Promise<string[]>} - Liste des dates disponibles
   */
  async getAvailableDates(sport) {
    throw new Error('Method getAvailableDates must be implemented');
  }
}

module.exports = StorageManager;
