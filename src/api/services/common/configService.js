/**
 * @fileoverview Service de gestion de la configuration par pays
 * Gère la détection du pays, le cache et les opérations CRUD
 */
const HttpClient = require('../../../utils/httpClient');
const AppConfig = require('../../models/common/AppConfig');
const logger = require('../../../utils/logger');

class ConfigService {
  constructor() {
    // Client HTTP natif
    this.httpClient = new HttpClient();
    
    // Cache en mémoire pour éviter trop d'appels API
    this.ipCache = new Map();
    this.configCache = new Map();
    this.CACHE_TTL = 3600000; // 1 heure en millisecondes
  }

  /**
   * Détecter le pays depuis une adresse IP avec toutes les informations nécessaires
   * @param {string} ipAddress - Adresse IP de l'utilisateur
   * @returns {Promise<Object>} Informations du pays {countryCode, countryName, currency, phonePrefix}
   */
  async detectCountryFromIp(ipAddress) {
    try {
      // Vérifier le cache
      if (this.ipCache.has(ipAddress)) {
        logger.info(`[ConfigService] IP en cache: ${ipAddress}`);
        return this.ipCache.get(ipAddress);
      }

      logger.info(`[ConfigService] Détection du pays pour IP: ${ipAddress}`);

      // Appeler l'API de géolocalisation avec tous les champs nécessaires
      const response = await this.httpClient.get(
        `http://ip-api.com/json/${ipAddress}`,
        {
          params: {
            fields: 'status,countryCode,country,currency,callingCode',
          },
        }
      );

      if (response.status === 'success' && response.countryCode) {
        const countryInfo = {
          countryCode: response.countryCode.toUpperCase(),
          countryName: response.country,
          currency: response.currency || 'USD', // Fallback USD si pas disponible
          phonePrefix: response.callingCode ? `+${response.callingCode}` : '+1' // Fallback +1
        };

        // Mettre en cache
        this.ipCache.set(ipAddress, countryInfo);

        // Nettoyer le cache après TTL
        setTimeout(() => {
          this.ipCache.delete(ipAddress);
          logger.info(`[ConfigService] Cache IP expiré: ${ipAddress}`);
        }, this.CACHE_TTL);

        logger.info(`[ConfigService] Pays détecté: ${JSON.stringify(countryInfo)}`);
        return countryInfo;
      }

      throw new Error('Impossible de détecter le pays depuis l\'IP');
    } catch (error) {
      logger.error(`[ConfigService] Erreur détection IP: ${error.message}`);
      throw new Error(`Impossible de détecter le pays depuis l'IP: ${error.message}`);
    }
  }

  /**
   * Obtenir ou créer automatiquement une configuration par code pays
   * @param {string} countryCode - Code pays (ex: "CM")
   * @param {Object} countryInfo - Informations du pays {countryName, currency, phonePrefix}
   * @returns {Promise<Object>} Configuration du pays
   */
  async getOrCreateConfigByCountryCode(countryCode, countryInfo) {
    try {
      const upperCountryCode = countryCode.toUpperCase();
      const cacheKey = `config_${upperCountryCode}`;

      // Vérifier le cache
      if (this.configCache.has(cacheKey)) {
        logger.info(`[ConfigService] Config en cache: ${upperCountryCode}`);
        return this.configCache.get(cacheKey);
      }

      // Chercher en base de données
      let config = await AppConfig.findOne({ countryCode: upperCountryCode });

      // Si la config n'existe pas, la créer automatiquement
      if (!config) {
        logger.info(`[ConfigService] Création automatique de la config pour: ${upperCountryCode}`);
        
        config = await AppConfig.create({
          countryCode: upperCountryCode,
          countryName: countryInfo.countryName,
          currency: countryInfo.currency,
          language: 'en', // Anglais par défaut
          phonePrefix: countryInfo.phonePrefix,
          paymentProvider: 'googlepay', // Google Pay par défaut
          isActive: true,
          metadata: {
            autoCreated: true,
            createdAt: new Date().toISOString()
          }
        });

        logger.info(`[ConfigService] Config créée automatiquement: ${upperCountryCode}`);
      }

      // Formater pour le client
      const clientConfig = config.toClientJSON ? config.toClientJSON() : config.toObject();

      // Mettre en cache
      this.configCache.set(cacheKey, clientConfig);

      // Nettoyer le cache après TTL
      setTimeout(() => {
        this.configCache.delete(cacheKey);
        logger.info(`[ConfigService] Cache config expiré: ${upperCountryCode}`);
      }, this.CACHE_TTL);

      logger.info(`[ConfigService] Config récupérée/créée: ${upperCountryCode}`);
      return clientConfig;
    } catch (error) {
      logger.error(`[ConfigService] Erreur getOrCreateConfigByCountryCode: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtenir la configuration par adresse IP (avec création automatique)
   * @param {string} ipAddress - Adresse IP de l'utilisateur
   * @returns {Promise<Object>} Configuration du pays
   */
  async getConfigByIp(ipAddress) {
    try {
      // 1. Détecter le pays depuis l'IP (avec toutes les infos depuis l'API)
      const countryInfo = await this.detectCountryFromIp(ipAddress);

      // 2. Récupérer ou créer la config du pays
      return await this.getOrCreateConfigByCountryCode(
        countryInfo.countryCode,
        countryInfo
      );
    } catch (error) {
      logger.error(`[ConfigService] Erreur getConfigByIp: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtenir la configuration par code pays (sans création automatique)
   * @param {string} countryCode - Code pays (ex: "CM")
   * @returns {Promise<Object>} Configuration du pays
   */
  async getConfigByCountryCode(countryCode) {
    try {
      const upperCountryCode = countryCode.toUpperCase();
      const cacheKey = `config_${upperCountryCode}`;

      // Vérifier le cache
      if (this.configCache.has(cacheKey)) {
        logger.info(`[ConfigService] Config en cache: ${upperCountryCode}`);
        return this.configCache.get(cacheKey);
      }

      // Récupérer depuis la DB
      const config = await AppConfig.findOne({ countryCode: upperCountryCode });

      if (!config) {
        throw new Error(`Configuration non trouvée pour le pays: ${upperCountryCode}`);
      }

      // Formater pour le client
      const clientConfig = config.toClientJSON ? config.toClientJSON() : config.toObject();

      // Mettre en cache
      this.configCache.set(cacheKey, clientConfig);

      // Nettoyer le cache après TTL
      setTimeout(() => {
        this.configCache.delete(cacheKey);
        logger.info(`[ConfigService] Cache config expiré: ${upperCountryCode}`);
      }, this.CACHE_TTL);

      logger.info(`[ConfigService] Config récupérée: ${upperCountryCode}`);
      return clientConfig;
    } catch (error) {
      logger.error(`[ConfigService] Erreur getConfigByCountryCode: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtenir toutes les configurations (Admin)
   * @returns {Promise<Array>} Liste des configurations
   */
  async getAllConfigs() {
    try {
      const configs = await AppConfig.find().sort({ countryName: 1 });
      return configs;
    } catch (error) {
      logger.error(`[ConfigService] Erreur getAllConfigs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Créer ou mettre à jour une configuration (Admin)
   * @param {string} countryCode - Code pays
   * @param {Object} configData - Données de configuration
   * @returns {Promise<Object>} Configuration créée/mise à jour
   */
  async upsertConfig(countryCode, configData) {
    try {
      const config = await AppConfig.findOneAndUpdate(
        { countryCode: countryCode.toUpperCase() },
        { ...configData, countryCode: countryCode.toUpperCase() },
        { new: true, upsert: true, runValidators: true }
      );

      // Invalider le cache
      this.configCache.delete(`config_${countryCode.toUpperCase()}`);

      logger.info(`[ConfigService] Config upsert: ${countryCode}`);
      return config;
    } catch (error) {
      logger.error(`[ConfigService] Erreur upsertConfig: ${error.message}`);
      throw error;
    }
  }

  /**
   * Supprimer une configuration (Admin)
   * @param {string} countryCode - Code pays
   * @returns {Promise<Object>} Résultat de la suppression
   */
  async deleteConfig(countryCode) {
    try {
      const result = await AppConfig.findOneAndDelete({
        countryCode: countryCode.toUpperCase(),
      });

      if (!result) {
        throw new Error('Configuration non trouvée');
      }

      // Invalider le cache
      this.configCache.delete(`config_${countryCode.toUpperCase()}`);

      logger.info(`[ConfigService] Config supprimée: ${countryCode}`);
      return result;
    } catch (error) {
      logger.error(`[ConfigService] Erreur deleteConfig: ${error.message}`);
      throw error;
    }
  }

  /**
   * Activer/désactiver un pays (Admin)
   * @param {string} countryCode - Code pays
   * @param {boolean} isActive - État actif/inactif
   * @returns {Promise<Object>} Configuration mise à jour
   */
  async toggleCountry(countryCode, isActive) {
    try {
      const config = await AppConfig.findOneAndUpdate(
        { countryCode: countryCode.toUpperCase() },
        { isActive },
        { new: true }
      );

      if (!config) {
        throw new Error('Configuration non trouvée');
      }

      // Invalider le cache
      this.configCache.delete(`config_${countryCode.toUpperCase()}`);

      logger.info(`[ConfigService] Config toggle: ${countryCode} -> ${isActive}`);
      return config;
    } catch (error) {
      logger.error(`[ConfigService] Erreur toggleCountry: ${error.message}`);
      throw error;
    }
  }

  /**
   * Vider les caches (Admin/Debug)
   */
  clearCache() {
    this.ipCache.clear();
    this.configCache.clear();
    logger.info('[ConfigService] Caches vidés');
  }
}

// Export singleton
module.exports = new ConfigService();