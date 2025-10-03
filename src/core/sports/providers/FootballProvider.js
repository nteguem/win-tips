/**
 * @fileoverview Fournisseur de données pour le football - VERSION CORRIGÉE
 */
const SportProvider = require('./SportProvider');

/**
 * Fournisseur de données pour le football
 * @extends SportProvider
 */
class FootballProvider extends SportProvider {
  /**
   * @param {Object} config - Configuration
   * @param {Object} dependencies - Dépendances injectées
   */
  constructor(config, dependencies) {
    super(config, dependencies);
    this.endpoints = {
      fixtures: '/fixtures'
    };
  }
  
  /**
   * Récupère les matchs pour une date spécifique
   * @param {string} date - Date au format YYYY-MM-DD
   * @returns {Promise<Object>} - Données des matchs
   */
  async fetchFixtures(date) {
    try {
      this.logger.info(`Fetching football fixtures for ${date}`);
      
      const response = await this.httpClient.get(`${this.baseUrl}${this.endpoints.fixtures}`, {
        params: { date },
        headers: {
          'x-rapidapi-key': this.apiKey,
          'x-rapidapi-host': this.host
        }
      });
      
      return response;
    } catch (error) {
      throw this.handleApiError(error, `fetchFixtures(${date})`);
    }
  }
  
  /**
   * Transforme les données brutes en format standardisé
   * @param {Object} rawData - Données brutes de l'API
   * @returns {Object} - Données normalisées
   */
  normalizeData(rawData) {
    const fixtures = rawData.response || [];
    const date = rawData.parameters?.date;
    
    // Créer l'index des pays et ligues avec IDs cohérents
    const countriesMap = new Map();
    const leagues = {};
    
    // Normaliser les matchs
    const matches = fixtures.map(fixture => {
      // Extraire le pays et créer un ID cohérent
      const countryName = fixture.league.country;
      const countryId = countryName.toLowerCase().replace(/\s+/g, '-');
      
      // Stocker le mapping pays
      if (!countriesMap.has(countryId)) {
        countriesMap.set(countryId, {
          id: countryId,
          name: countryName,
          flag: fixture.league.flag
        });
      }
      
      // Indexer les ligues par ID de pays
      if (!leagues[countryId]) {
        leagues[countryId] = new Set();
      }
      leagues[countryId].add(fixture.league.name);
      
      // Normaliser le statut
      let normalizedStatus;
      switch(fixture.fixture.status.short) {
        case 'NS': normalizedStatus = 'NOT_STARTED'; break;
        case 'LIVE': normalizedStatus = 'LIVE'; break;
        case 'FT': normalizedStatus = 'FINISHED'; break;
        case 'CANC': normalizedStatus = 'CANCELLED'; break;
        default: normalizedStatus = fixture.fixture.status.short;
      }
      
      // Retourner le match normalisé avec countryId cohérent
      return {
        id: fixture.fixture.id.toString(),
        date: fixture.fixture.date,
        league: {
          id: fixture.league.id.toString(),
          name: fixture.league.name,
          country: countryName,
          countryId: countryId, // AJOUT : ID cohérent pour les URL
          logo: fixture.league.logo,
          flag: fixture.league.flag
        },
        teams: {
          home: {
            id: fixture.teams.home.id.toString(),
            name: fixture.teams.home.name,
            logo: fixture.teams.home.logo
          },
          away: {
            id: fixture.teams.away.id.toString(),
            name: fixture.teams.away.name,
            logo: fixture.teams.away.logo
          }
        },
        venue: fixture.fixture.venue,
        status: normalizedStatus,
        score: {
          home: fixture.goals.home,
          away: fixture.goals.away,
          details: {
            halftime: fixture.score.halftime || { home: null, away: null },
            fulltime: fixture.score.fulltime || { home: null, away: null },
            extratime: fixture.score.extratime || { home: null, away: null },
            penalty: fixture.score.penalty || { home: null, away: null }
          }
        },
        sportSpecific: {
          elapsed: fixture.fixture.status.elapsed,
          referee: fixture.fixture.referee,
          round: fixture.league.round,
          season: fixture.league.season
        }
      };
    });
    
    // Convertir en format pour les index
    const countriesArray = Array.from(countriesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    const leaguesObj = {};
    
    for (const countryId in leagues) {
      leaguesObj[countryId] = Array.from(leagues[countryId]).sort();
    }
    
    return {
      sport: 'football',
      date,
      source: 'api-football',
      matches,
      indexes: {
        countries: countriesArray, // Maintenant avec {id, name, flag}
        leagues: leaguesObj // Indexé par countryId
      }
    };
  }
}

module.exports = FootballProvider;