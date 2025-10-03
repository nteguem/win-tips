/**
 * @fileoverview Gestionnaire de stockage basé sur des fichiers
 */
const fs = require('fs');
const path = require('path');
const { AppError } = require('../../../utils/errorHandler');
const StorageManager = require('./StorageManager');

/**
 * Gestionnaire de stockage basé sur des fichiers
 * @extends StorageManager
 */
class FileStorageManager extends StorageManager {
  /**
   * @param {Object} config - Configuration
   * @param {string} config.basePath - Chemin de base pour le stockage
   * @param {Object} dependencies - Dépendances injectées
   * @param {Object} dependencies.logger - Logger
   */
  constructor(config, { logger }) {
    super({ logger });
    this.basePath = config.basePath || path.join(process.cwd(), 'data', 'sports');
    this.ensureDirectoriesExist();
  }
  
  /**
   * Vérifie et crée les dossiers requis
   * @private
   */
  ensureDirectoriesExist() {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
      this.logger.info(`Created base storage directory: ${this.basePath}`);
    }
  }
  
  /**
   * Obtient le chemin du fichier pour un sport et une date
   * @private
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @returns {string} - Chemin du fichier
   */
  getFilePath(sport, date) {
    const sportDir = path.join(this.basePath, sport);
    
    if (!fs.existsSync(sportDir)) {
      fs.mkdirSync(sportDir, { recursive: true });
      this.logger.info(`Created sport directory: ${sportDir}`);
    }
    
    return path.join(sportDir, `${date}.json`);
  }
  
  /**
   * Sauvegarde des données
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @param {Object} data - Données à sauvegarder
   * @returns {Promise<boolean>} - Statut de la sauvegarde
   */
  async saveData(sport, date, data) {
    try {
      const filePath = this.getFilePath(sport, date);
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
      this.logger.info(`Saved ${sport} data for ${date}`);
      return true;
    } catch (error) {
      this.logger.error(`Error saving ${sport} data for ${date}: ${error.message}`);
      throw new AppError(`Failed to save data: ${error.message}`, 500);
    }
  }
  
  /**
   * Récupère des données
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @returns {Promise<Object>} - Données récupérées
   */
  async getData(sport, date) {
    try {
      const filePath = this.getFilePath(sport, date);
      
      if (!fs.existsSync(filePath)) {
        throw new AppError(`No data found for ${sport} on ${date}`, 404);
      }
      
      const data = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.error(`Error reading ${sport} data for ${date}: ${error.message}`);
      throw new AppError(`Failed to read data: ${error.message}`, 500);
    }
  }
  
  /**
   * Vérifie si des données existent
   * @param {string} sport - Type de sport
   * @param {string} date - Date (YYYY-MM-DD)
   * @returns {Promise<boolean>} - True si les données existent
   */
  async dataExists(sport, date) {
    const filePath = this.getFilePath(sport, date);
    return fs.existsSync(filePath);
  }
  
  /**
   * Récupère les dates disponibles
   * @param {string} sport - Type de sport
   * @returns {Promise<string[]>} - Liste des dates disponibles
   */
  async getAvailableDates(sport) {
    try {
      const sportDir = path.join(this.basePath, sport);
      
      if (!fs.existsSync(sportDir)) {
        return [];
      }
      
      const files = await fs.promises.readdir(sportDir);
      
      // Filtrer pour ne garder que les fichiers JSON et extraire les dates
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''))
        .sort();
    } catch (error) {
      this.logger.error(`Error getting available dates for ${sport}: ${error.message}`);
      return [];
    }
  }
}

module.exports = FileStorageManager;