/**
 * @fileoverview Classe abstraite pour les fournisseurs de données sportives
 */
const { AppError } = require('../../../utils/errorHandler');

/**
 * Classe de base pour les fournisseurs de données sportives
 * @abstract
 */
class SportProvider {
  /**
   * Crée une instance de SportProvider
   * @param {Object} config - Configuration du fournisseur
   * @param {Object} dependencies - Dépendances injectées
   * @param {Object} dependencies.httpClient - Client HTTP
   * @param {Object} dependencies.logger - Logger
   */
  constructor(config, { httpClient, logger }) {
    if (this.constructor === SportProvider) {
      throw new Error('SportProvider is an abstract class and cannot be instantiated directly');
    }
    
    this.config = config;
    this.name = config.name;
    this.sportId = config.sportId;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.host = config.host;
    
    // Dépendances injectées
    this.httpClient = httpClient;
    this.logger = logger;
  }
  
  /**
   * Récupère les matchs pour une date spécifique
   * @abstract
   * @param {string} date - Date au format YYYY-MM-DD
   * @returns {Promise<Object>} - Données des matchs
   */
  async fetchFixtures(date) {
    throw new Error('Method fetchFixtures must be implemented');
  }
  
  /**
   * Transforme les données brutes en format standardisé
   * @abstract
   * @param {Object} rawData - Données brutes de l'API
   * @returns {Object} - Données normalisées
   */
  normalizeData(rawData) {
    throw new Error('Method normalizeData must be implemented');
  }
  
  /**
   * Gère les erreurs API
   * @protected
   * @param {Error} error - Erreur survenue
   * @param {string} operation - Opération en cours
   * @returns {Error} - Erreur formatée
   */
  handleApiError(error, operation) {
    this.logger.error(`API Error in ${this.name} provider (${operation}): ${error.message}`);
    
    // Gérer différents types d'erreurs API
    if (error.response) {
      // La requête a été faite et le serveur a répondu avec un statut d'erreur
      const status = error.response.status;
      const data = error.response.data;
      
      if (status === 429) {
        return new AppError('API rate limit exceeded. Please try again later.', 429);
      } else if (status === 403 || status === 401) {
        return new AppError('API authentication failed. Please check your API key.', 403);
      }
      
      return new AppError(`API error: ${data.message || 'Unknown error'}`, 500);
    } else if (error.request) {
      // La requête a été faite mais aucune réponse n'a été reçue
      return new AppError('No response received from API. Please try again later.', 504);
    }
    
    // Erreur lors de la configuration de la requête
    return new AppError(`Error preparing API request: ${error.message}`, 500);
  }
}

module.exports = SportProvider;