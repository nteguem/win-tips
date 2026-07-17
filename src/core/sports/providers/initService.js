/**
 * @fileoverview Service d'initialisation des données sportives à la demande - VERSION CORRIGÉE
 */
require('dotenv').config();
const FootballProvider = require('./FootballProvider');
const BasketballProvider = require('./BasketballProvider');
const RugbyProvider = require('./RugbyProvider');
const HandballProvider = require('./HandballProvider');
const VolleyballProvider = require('./VolleyballProvider');
const BaseballProvider = require('./BaseballProvider');
const HockeyProvider = require('./HockeyProvider');
const TennisProvider = require('./TennisProvider');
const HorseProvider = require('./HorseProvider');
const FileStorageManager = require('../storage/FileStorageManager');
const logger = require('../../../utils/logger');
const path = require('path');
const HttpClient = require('../../../utils/httpClient');

// Dépendances
const httpClient = new HttpClient();

const sportsConfig = {
  football: {
    name: 'Football',
    icon: '⚽',
    sportId: 'football',
    // Migré de RapidAPI vers API-Sports (accès direct) le 2026-07-17
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v3.football.api-sports.io',
    host: 'v3.football.api-sports.io'
  },
  basketball: {
    name: 'Basketball',
    icon: '🏀',
    sportId: 'basketball',
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v1.basketball.api-sports.io',
    host: 'v1.basketball.api-sports.io'
  },
  rugby: {
    name: 'Rugby',
    icon: '🏉',
    sportId: 'rugby',
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v1.rugby.api-sports.io',
    host: 'v1.rugby.api-sports.io'
  },
  handball: {
    name: 'Handball',
    icon: '🤾',
    sportId: 'handball',
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v1.handball.api-sports.io',
    host: 'v1.handball.api-sports.io'
  },
  volleyball: {
    name: 'Volleyball',
    icon: '🏐',
    sportId: 'volleyball',
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v1.volleyball.api-sports.io',
    host: 'v1.volleyball.api-sports.io'
  },
  baseball: {
    name: 'Baseball',
    icon: '⚾',
    sportId: 'baseball',
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v1.baseball.api-sports.io',
    host: 'v1.baseball.api-sports.io'
  },
  hockey: {
    name: 'Hockey',
    icon: '🏒',
    sportId: 'hockey',
    apiKey: process.env.API_SPORTS_KEY,
    baseUrl: 'https://v1.hockey.api-sports.io',
    host: 'v1.hockey.api-sports.io'
  },
  tennis: {
    name: 'Tennis',
    icon: '🎾',
    sportId: 'tennis',
    apiKey: process.env.RAPID_API_KEY_TENNIS,
    baseUrl: 'https://tennis-api-atp-wta-itf.p.rapidapi.com',
    host: 'tennis-api-atp-wta-itf.p.rapidapi.com'
  },
  horse: {
    name: 'Courses Hippiques',
    icon: '🏇',
    sportId: 'horse',
    apiKey: null, 
    baseUrl: 'https://online.turfinfo.api.pmu.fr/rest/client/61',
    host: 'online.turfinfo.api.pmu.fr'
  }
};

// Fournisseurs
const providers = {
  football: new FootballProvider(sportsConfig.football, { httpClient, logger }),
  basketball: new BasketballProvider(sportsConfig.basketball, { httpClient, logger }),
  rugby: new RugbyProvider(sportsConfig.rugby, { httpClient, logger }),
  handball: new HandballProvider(sportsConfig.handball, { httpClient, logger }),
  volleyball: new VolleyballProvider(sportsConfig.volleyball, { httpClient, logger }),
  baseball: new BaseballProvider(sportsConfig.baseball, { httpClient, logger }),
  hockey: new HockeyProvider(sportsConfig.hockey, { httpClient, logger }),
  tennis: new TennisProvider(sportsConfig.tennis, { httpClient, logger }),
  horse: new HorseProvider(sportsConfig.horse, { httpClient, logger })
};

// Stockage local
const storageManager = new FileStorageManager({
  basePath: path.join(process.cwd(), 'data', 'sports')
}, { logger });

/**
 * Récupère les données (stock local ou API) - VERSION AMÉLIORÉE
 */
const fetchAndStoreData = async (sport, date, forceRefresh = false) => {
  try {
    logger.info(`Fetching data for ${sport} on ${date} (force: ${forceRefresh})`);
    
    const exists = await storageManager.dataExists(sport, date);
    
    if (exists && !forceRefresh) {
      logger.info(`Data for ${sport} on ${date} already exists. Loading from storage...`);
      const cachedData = await storageManager.getData(sport, date);
      
      // AJOUT : Validation des données cachées
      if (cachedData && cachedData.matches && Array.isArray(cachedData.matches)) {
        logger.info(`Loaded ${cachedData.matches.length} matches from cache for ${sport} on ${date}`);
        return cachedData;
      } else {
        logger.warn(`Cached data for ${sport} on ${date} is invalid, forcing refresh`);
        forceRefresh = true;
      }
    }
    
    const provider = providers[sport];
    if (!provider) throw new Error(`No provider configured for sport: ${sport}`);
    
    logger.info(`Fetching fresh data from API for ${sport} on ${date}`);
    const rawData = await provider.fetchFixtures(date);
    
    // MODIFIÉ : Validation des données de l'API adaptée par sport
    if (!rawData) {
      throw new Error(`Invalid API response for ${sport} on ${date}`);
    }
    
    // Pour les sports RapidAPI classiques (football, basketball, rugby, etc.), vérifier rawData.response
    if (['football', 'basketball', 'rugby', 'handball', 'volleyball', 'baseball', 'hockey'].includes(sport) && !rawData.response) {
      throw new Error(`Invalid API response for ${sport} on ${date}: missing response field`);
    }
    
    // Pour tennis, vérifier rawData.data
    if (sport === 'tennis' && !rawData.data) {
      throw new Error(`Invalid API response for tennis on ${date}: missing data field`);
    }
    
    // Pour horse, vérifier la structure PMU
    if (sport === 'horse' && !rawData.programme && !rawData.reunions && !rawData.courses) {
      throw new Error(`Invalid API response for horse on ${date}: missing programme/reunions/courses`);
    }
    
    // Gérer les providers avec normalizeData async ou sync
    const normalizedData = await Promise.resolve(provider.normalizeData(rawData));
    
    // AJOUT : Validation des données normalisées
    if (!normalizedData || !normalizedData.matches || !Array.isArray(normalizedData.matches)) {
      throw new Error(`Failed to normalize data for ${sport} on ${date}`);
    }
    
    // AJOUT : Log des statistiques
    logger.info(`Normalized ${normalizedData.matches.length} matches for ${sport} on ${date}`);
    if (normalizedData.stats) {
      logger.info(`Stats: ${JSON.stringify(normalizedData.stats)}`);
    }
    
    await storageManager.saveData(sport, date, normalizedData);
    logger.info(`Data saved successfully for ${sport} on ${date}`);
    
    return normalizedData;
  } catch (error) {
    logger.error(`Error fetching/storing data for ${sport} on ${date}: ${error.message}`);
    
    // AJOUT : Tentative de récupération des données cachées en cas d'erreur API
    if (!forceRefresh) {
      try {
        const exists = await storageManager.dataExists(sport, date);
        if (exists) {
          logger.warn(`API failed, attempting to use cached data for ${sport} on ${date}`);
          const cachedData = await storageManager.getData(sport, date);
          if (cachedData && cachedData.matches) {
            logger.info(`Successfully recovered from cache: ${cachedData.matches.length} matches`);
            return cachedData;
          }
        }
      } catch (cacheError) {
        logger.error(`Cache recovery also failed: ${cacheError.message}`);
      }
    }
    
    throw error;
  }
};

/**
 * Liste les dates disponibles en local
 */
const getAvailableDates = async (sport) => {
  try {
    const dates = await storageManager.getAvailableDates(sport);
    logger.info(`Found ${dates.length} available dates for ${sport}`);
    return dates.sort(); // AJOUT : Tri chronologique
  } catch (error) {
    logger.error(`Error getting available dates for ${sport}: ${error.message}`);
    return []; // AJOUT : Retourner un tableau vide en cas d'erreur
  }
};

/**
 * Recherche un match/course précis dans les données - VERSION AMÉLIORÉE
 */
const findMatch = async (sport, matchId, date = null, forceUpdate = false) => {
  try {
    if (!sportsConfig[sport]) throw new Error(`Sport not found: ${sport}`);
    
    logger.info(`Searching for match ${matchId} in ${sport}${date ? ` on ${date}` : ''}`);
    
    let matchData = null;
    
    // Recherche dans la date spécifiée en premier
    if (date) {
      try {
        const dateData = await fetchAndStoreData(sport, date, forceUpdate);
        matchData = dateData.matches.find(match => match.id === matchId);
        if (matchData) {
          logger.info(`Match ${matchId} found in specified date ${date}`);
          return matchData;
        }
      } catch (err) {
        logger.warn(`Failed to search in specified date ${date}: ${err.message}`);
      }
    }
    
    // Recherche dans toutes les dates disponibles
    const availableDates = await getAvailableDates(sport);
    logger.info(`Searching across ${availableDates.length} available dates`);
    
    for (const availableDate of availableDates) {
      if (availableDate === date) continue; // Déjà testé
      
      try {
        const dateData = await fetchAndStoreData(sport, availableDate, forceUpdate);
        matchData = dateData.matches.find(match => match.id === matchId);
        if (matchData) {
          logger.info(`Match ${matchId} found in date ${availableDate}`);
          return matchData;
        }
      } catch (err) {
        logger.warn(`Skipping date ${availableDate}: ${err.message}`);
      }
    }
    
    logger.warn(`Match ${matchId} not found in any available data for ${sport}`);
    return null;
  } catch (error) {
    logger.error(`Error finding match ${matchId} for ${sport}: ${error.message}`);
    throw error;
  }
};

/**
 * AJOUT : Fonction utilitaire pour obtenir des statistiques sur les données
 */
const getDataStats = async (sport, date) => {
  try {
    const data = await fetchAndStoreData(sport, date);
    return {
      sport,
      date,
      totalMatches: data.matches.length,
      countries: data.indexes.countries.length,
      leagues: Object.keys(data.indexes.leagues).length,
      lastUpdated: data.lastUpdated || 'unknown'
    };
  } catch (error) {
    logger.error(`Error getting stats for ${sport} on ${date}: ${error.message}`);
    return null;
  }
};

module.exports = {
  fetchAndStoreData,
  getAvailableDates,
  findMatch,
  getDataStats, // AJOUT : Export de la nouvelle fonction
  sportsConfig
};