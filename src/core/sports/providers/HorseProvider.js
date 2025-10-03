/**
 * @fileoverview Fournisseur de données pour les courses hippiques
 */
const SportProvider = require('./SportProvider');

/**
 * Fournisseur de données pour les courses hippiques
 * @extends SportProvider
 */
class HorseProvider extends SportProvider {
  /**
   * @param {Object} config - Configuration
   * @param {Object} dependencies - Dépendances injectées
   */
  constructor(config, dependencies) {
    super(config, dependencies);
    this.endpoints = {
      fixtures: '/programme' // endpoint pour récupérer le programme
    };
  }
  
  /**
   * Récupère les courses pour une date spécifique
   * @param {string} date - Date au format YYYY-MM-DD
   * @returns {Promise<Object>} - Données des courses
   */
  async fetchFixtures(date) {
    try {
      // Convertir YYYY-MM-DD en DDMMYYYY pour l'API PMU
      const formattedDate = this.formatDateForPMU(date);
      
      this.logger.info(`Fetching horse races for ${date} (${formattedDate})`);
      
      // URL complète pour l'API PMU
      const url = `${this.baseUrl}${this.endpoints.fixtures}/${formattedDate}`;
      
      const response = await this.httpClient.get(url, {
        params: { 
          meteo: 'true', 
          specialisation: 'INTERNET' 
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'Referer': 'https://www.pmu.fr/',
          'Origin': 'https://www.pmu.fr'
        },
        timeout: 30000 // Timeout de 30 secondes
      });
      
      return response;
    } catch (error) {
      throw this.handleApiError(error, `fetchFixtures(${date})`);
    }
  }
  
  /**
   * Convertit une date YYYY-MM-DD en DDMMYYYY
   * @param {string} date - Date au format YYYY-MM-DD
   * @returns {string} - Date au format DDMMYYYY
   */
  formatDateForPMU(date) {
    const [year, month, day] = date.split('-');
    return `${day}${month}${year}`;
  }
  
  /**
   * Récupère les participants d'une course spécifique
   * @param {string} date - Date au format YYYY-MM-DD
   * @param {string} raceId - ID de la course au format R2-C1
   * @returns {Promise<Object>} - Données des participants
   */
  async fetchParticipants(date, raceId) {
    try {
      // Convertir YYYY-MM-DD en DDMMYYYY pour l'API PMU
      const formattedDate = this.formatDateForPMU(date);
      
      // Extraire R2 et C1 depuis R2-C1
      const [reunion, course] = raceId.split('-');
      
      this.logger.info(`Fetching participants for race ${raceId} on ${date}`);
      
      // URL: /programme/05092025/R2/C2/participants
      const url = `${this.baseUrl}/programme/${formattedDate}/${reunion}/${course}/participants`;
      
      const response = await this.httpClient.get(url, {
        params: { 
          specialisation: 'INTERNET' 
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'Referer': 'https://www.pmu.fr/',
          'Origin': 'https://www.pmu.fr'
        },
        timeout: 30000
      });
      
      return response;
    } catch (error) {
      throw this.handleApiError(error, `fetchParticipants(${date}, ${raceId})`);
    }
  }

    /**
   * Normalise les données des participants
   * @param {Object} rawData - Données brutes des participants
   * @returns {Object} - Participants normalisés
   */
  normalizeParticipants(rawData) {
    const participants = rawData.participants || [];
    
    return {
      raceId: null, // Sera ajouté par le controller
      participants: participants.map(participant => ({
        numero: participant.numPmu,
        nom: participant.nom,
        age: participant.age,
        sexe: participant.sexe,
        race: participant.race,
        statut: participant.statut,
        placeCorde: participant.placeCorde,
        proprietaire: participant.proprietaire,
        entraineur: participant.entraineur,
        jockey: participant.driver,
        musique: participant.musique,
        performances: {
          courses: participant.nombreCourses,
          victoires: participant.nombreVictoires,
          places: participant.nombrePlaces,
          gainsCarriere: participant.gainsParticipant?.gainsCarriere || 0
        },
        genealogie: {
          pere: participant.nomPere,
          mere: participant.nomMere,
          pereMere: participant.nomPereMere
        },
        casaque: participant.urlCasaque,
        handicap: participant.handicapPoids,
        allure: participant.allure
      })).filter(p => p.statut === 'PARTANT') // Seulement les partants
        .sort((a, b) => a.numero - b.numero), // Trier par numéro
      
      totalPartants: participants.filter(p => p.statut === 'PARTANT').length,
      sprites: rawData.spriteCasaques || []
    };
  }
  /**
   * Transforme les données brutes en format standardisé
   * @param {Object} rawData - Données brutes de l'API PMU
   * @returns {Object} - Données normalisées
   */
  normalizeData(rawData) {
    if (!rawData || typeof rawData !== 'object') {
      return {
        sport: 'horse',
        date: null,
        source: 'pmu-turfinfo',
        rawData: rawData || {},
        matches: [],
        indexes: {
          countries: [{id: 'france', name: 'France', flag: 'https://media.api-sports.io/flags/fr.svg'}],
          leagues: { 'france': [] }
        }
      };
    }

    // L'API PMU retourne les données dans rawData.programme.reunions
    let reunions = [];
    let dateReunion = null;
    
    // Cas 1: Structure complète avec programme
    if (rawData.programme && Array.isArray(rawData.programme.reunions)) {
      reunions = rawData.programme.reunions;
      dateReunion = rawData.programme.date;
    }
    // Cas 2: Les données contiennent directement les réunions
    else if (Array.isArray(rawData.reunions)) {
      reunions = rawData.reunions;
      dateReunion = rawData.dateReunion;
    }
    // Cas 3: rawData est directement une réunion avec des courses
    else if (rawData.courses && Array.isArray(rawData.courses)) {
      reunions = [rawData];
      dateReunion = rawData.dateReunion;
    }
    
    // Extraire la date depuis les données ou utiliser une date par défaut
    let date = null;
    if (dateReunion) {
      date = new Date(dateReunion).toISOString().split('T')[0];
    }
    
    // Si pas de réunions, retourner une structure vide
    if (reunions.length === 0) {
      return {
        sport: 'horse',
        date,
        source: 'pmu-turfinfo',
        rawData,
        matches: [],
        indexes: {
          countries: [{id: 'france', name: 'France', flag: 'https://media.api-sports.io/flags/fr.svg'}],
          leagues: { 'france': [] }
        }
      };
    }
    
    // Créer l'index des pays et ligues (hippodromes) - FORMAT HARMONISÉ
    const countriesMap = new Map();
    const leagues = {};
    
    // Ajouter la France au map
    countriesMap.set('france', {
      id: 'france',
      name: 'France',
      flag: 'https://media.api-sports.io/flags/fr.svg'
    });
    
    leagues['france'] = new Set();
    
    // Normaliser les courses
    const matches = [];
    
    reunions.forEach((reunion) => {
      const hippodrome = reunion.hippodrome?.libelleCourt || 'Hippodrome inconnu';
      leagues['france'].add(hippodrome);
      
      // Vérifier que reunion.courses existe et est un tableau
      const courses = reunion.courses || [];
      
      courses.forEach((course) => {
        // Normaliser le statut
        let normalizedStatus;
        switch(course.statut) {
          case 'PROGRAMMEE': normalizedStatus = 'NOT_STARTED'; break;
          case 'ROUGE_AUX_PARTANTS': normalizedStatus = 'LIVE'; break;
          case 'FIN_COURSE': normalizedStatus = 'FINISHED'; break;
          case 'ANNULEE': normalizedStatus = 'CANCELLED'; break;
          default: normalizedStatus = course.statut || 'UNKNOWN';
        }
        
        // Transformer la course en format match standardisé
        const match = {
          id: `R${reunion.numOfficiel || 0}-C${course.numOrdre || 0}`,
          date: course.heureDepart ? new Date(course.heureDepart).toISOString() : new Date().toISOString(),
          league: {
            id: reunion.hippodrome?.code || 'UNK',
            name: reunion.hippodrome?.libelleCourt || 'Hippodrome inconnu',
            country: 'France',
            countryId: 'france', // ID cohérent pour les URL
            logo: '🏇',
            flag: 'https://media.api-sports.io/flags/fr.svg'
          },
          teams: {
            home: {
              id: 'field',
              name: 'Partants',
              logo: null
            },
            away: {
              id: 'odds',
              name: `${course.nombreDeclaresPartants || 0} chevaux`,
              logo: null
            }
          },
          venue: {
            id: reunion.hippodrome?.code || 'UNK',
            name: reunion.hippodrome?.libelleLong || 'Hippodrome inconnu',
            city: reunion.hippodrome?.libelleCourt || 'Ville inconnue'
          },
          status: normalizedStatus,
          score: {
            home: course.ordreArrivee ? course.ordreArrivee[0]?.[0] : null,
            away: course.ordreArrivee ? course.ordreArrivee[1]?.[0] : null,
            details: {
              arrivee: course.ordreArrivee || null,
              enquete: course.indicateurEvenementArriveeProvisoire || null
            }
          },
          sportSpecific: {
            courseNumber: course.numOrdre || null,
            courseName: course.libelle || 'Course sans nom',
            courseNameShort: course.libelleCourt || course.libelle || 'Course',
            discipline: this.formatDiscipline(course.discipline, course.specialite),
            distance: course.distance ? `${course.distance}m` : null,
            track: course.corde === "CORDE_GAUCHE" ? "Gauche" : "Droite",
            runners: course.nombreDeclaresPartants || 0,
            conditions: {
              age: this.extractAgeFromConditions(course.conditions),
              sex: this.formatConditionSexe(course.conditionSexe),
              earnings: this.extractGainsFromConditions(course.conditions)
            },
            prize: {
              total: course.montantPrix || 0,
              first: course.montantOffert1er || 0,
              second: course.montantOffert2eme || 0,
              third: course.montantOffert3eme || 0
            },
            bettingTypes: course.paris ? course.paris.map(pari => ({
              type: this.formatTypePari(pari.typePari),
              baseStake: pari.miseBase || 0,
              available: pari.enVente || false
            })) : [],
            weather: rawData.programme?.meteo ? {
              temperature: rawData.programme.meteo.temperature,
              conditions: rawData.programme.meteo.nebulositeLibelleCourt,
              wind: {
                strength: rawData.programme.meteo.forceVent,
                direction: rawData.programme.meteo.directionVent
              }
            } : null,
            meetingType: this.formatTypeReunion(reunion.nature),
            raceDuration: course.dureeCourse || null
          }
        };
        
        matches.push(match);
      });
    });
    
    // Format identique aux autres providers
    const countriesArray = Array.from(countriesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    const leaguesObj = {};
    
    for (const countryId in leagues) {
      leaguesObj[countryId] = Array.from(leagues[countryId]).sort();
    }
    
    return {
      sport: 'horse',
      date,
      source: 'pmu-turfinfo',
      rawData,
      matches: matches.sort((a, b) => new Date(a.date) - new Date(b.date)),
      indexes: {
        countries: countriesArray, // [{id, name, flag}, ...]
        leagues: leaguesObj // Indexé par countryId
      }
    };
  }
  
  // Fonctions utilitaires spécifiques aux courses hippiques
  formatDiscipline(discipline, specialite) {
    if (!discipline) return 'Trot';
    
    const disciplines = {
      'MONTE': 'Trot monté',
      'ATTELE': 'Trot attelé',
      'GALOP': 'Galop'
    };
    return disciplines[discipline] || specialite || discipline;
  }
  
  formatConditionSexe(condition) {
    if (!condition) return 'Tous';
    
    const conditions = {
      'TOUS_CHEVAUX': 'Tous',
      'MALES_ET_HONGRES': 'Mâles et hongres',
      'FEMELLES': 'Juments'
    };
    return conditions[condition] || condition;
  }
  
  formatTypeReunion(nature) {
    if (!nature) return 'Diurne';
    
    const types = {
      'SEMINOCTURNE': 'Nocturne',
      'DIURNE': 'Diurne',
      'MATINALE': 'Matinale'
    };
    return types[nature] || nature;
  }
  
  formatTypePari(type) {
    if (!type) return '';
    return type.replace('E_', '').replace(/_/g, ' ').toLowerCase();
  }
  
  extractAgeFromConditions(conditions) {
    if (!conditions) return null;
    const ageMatch = conditions.match(/Pour (\d+) ans?/i) || 
                     conditions.match(/(\d+) (?:et|à) (\d+) ans/i);
    return ageMatch ? ageMatch[1] : null;
  }
  
  extractGainsFromConditions(conditions) {
    if (!conditions) return null;
    const gainsMatch = conditions.match(/gagné ([\d.]+)/i);
    return gainsMatch ? parseInt(gainsMatch[1].replace('.', '')) : null;
  }
}

module.exports = HorseProvider;