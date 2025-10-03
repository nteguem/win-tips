/**
 * @fileoverview Contrôleur pour les routes sportives - VERSION CORRIGÉE
 */
const {
  sportsConfig,
  fetchAndStoreData,
  findMatch
} = require('../../../core/sports/providers/initService');

const { AppError } = require('../../../utils/errorHandler');
const { formatSuccess, formatError } = require('../../../utils/responseFormatter');



/**
 * GET /api/sports
 */
exports.getAllSports = async (req, res, next) => {
  try {
    const sports = Object.entries(sportsConfig).map(([id, config]) => ({
      id,
      name: config.name,
      icon: config.icon,
    }));

    formatSuccess(res, {
      data: sports,
      count: sports.length
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/sports/:sport/dates/:date/countries
 */
exports.getCountries = async (req, res, next) => {
  try {
    const { sport, date } = req.params;
    const force = req.query.force === 'true';

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    const data = await fetchAndStoreData(sport, date, force);

    // Utiliser directement l'index des pays du provider
    const countries = data.indexes.countries;

    formatSuccess(res, {
      data: countries,
      count: countries.length
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/sports/:sport/dates/:date/countries/:country/leagues
 */
exports.getLeagues = async (req, res, next) => {
  try {
    const { sport, date, country } = req.params;
    const force = req.query.force === 'true';

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    const data = await fetchAndStoreData(sport, date, force);

    // Vérifier que le pays existe
    if (!data.indexes.leagues[country]) {
      throw new AppError(`Country not found: ${country}`, 404);
    }

    // Pour les courses hippiques
    if (sport === 'horse') {
      const hippodromes = data.matches
        .filter(match => match.league.countryId === country)
        .reduce((acc, match) => {
          let hippodrome = acc.find(h => h.id === match.league.id);
          
          if (!hippodrome) {
            const reunionNumber = match.id.split('-')[0];
            
            hippodrome = {
              id: match.league.id,
              name: match.league.name,
              logo: exports.getHippodromeEmoji ? exports.getHippodromeEmoji(match.league.id) : '🏇',
              reunionNumber: reunionNumber,
              racesCount: 0,
              disciplines: new Set(),
              specialRaces: [],
              weather: match.sportSpecific?.weather,
              nextRaceTime: null
            };
            acc.push(hippodrome);
          }
          
          hippodrome.racesCount++;
          
          if (match.sportSpecific?.discipline) {
            hippodrome.disciplines.add(match.sportSpecific.discipline);
          }
          
          if (match.sportSpecific?.bettingTypes) {
            const hasQuinte = match.sportSpecific.bettingTypes.some(bet => 
              bet.type.toLowerCase().includes('multi') || 
              bet.type.toLowerCase().includes('quinté')
            );
            if (hasQuinte && !hippodrome.specialRaces.includes('Q+')) {
              hippodrome.specialRaces.push('Q+');
            }
          }
          
          const raceTime = new Date(match.date);
          const now = new Date();
          if (raceTime > now && (!hippodrome.nextRaceTime || raceTime < new Date(hippodrome.nextRaceTime))) {
            hippodrome.nextRaceTime = match.date;
          }
          
          return acc;
        }, []);
      
      const leagues = hippodromes.map(h => ({
        ...h,
        disciplines: Array.from(h.disciplines),
        displayName: `${h.reunionNumber} ${h.name.toUpperCase()}`
      })).sort((a, b) => {
        const numA = parseInt(a.reunionNumber.replace('R', ''));
        const numB = parseInt(b.reunionNumber.replace('R', ''));
        return numA - numB;
      });

      return formatSuccess(res, {
        data: leagues,
        count: leagues.length
      });
    }

    // Pour les autres sports
    const leagues = data.matches
      .filter(match => match.league.countryId === country)
      .reduce((acc, match) => {
        if (!acc.find(l => l.id === match.league.id)) {
          acc.push({
            id: match.league.id,
            name: match.league.name,
            logo: match.league.logo
          });
        }
        return acc;
      }, []);

    leagues.sort((a, b) => a.name.localeCompare(b.name));

    formatSuccess(res, {
      data: leagues,
      count: leagues.length
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/sports/:sport/dates/:date/countries/:country/leagues/:league/fixtures
 */
exports.getFixtures = async (req, res, next) => {
  try {
    const { sport, date, country, league } = req.params;
    const force = req.query.force === 'true';

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    const data = await fetchAndStoreData(sport, date, force);

    // Filtrer par countryId et league
    const fixtures = data.matches.filter(
      match => 
        match.league.countryId === country && 
        match.league.id === league
    );

    if (fixtures.length === 0) {
      throw new AppError(`No fixtures found for league: ${league}`, 404);
    }

    // Format spécialisé pour les courses hippiques
    if (sport === 'horse') {
      const horseData = exports.formatHorseRaces ? exports.formatHorseRaces(fixtures, league) : fixtures;
      return formatSuccess(res, {
        data: horseData
      });
    }

    // Format standard - utiliser le vrai drapeau de l'API
    const fixturesWithFlag = fixtures.map(fixture => ({
      ...fixture,
      league: {
        ...fixture.league,
        countryFlag: fixture.league.flag
      }
    }));

    formatSuccess(res, {
      data: fixturesWithFlag,
      count: fixturesWithFlag.length
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/sports/:sport/matches/:matchId
 */
exports.getMatchDetails = async (req, res, next) => {
  try {
    const { sport, matchId } = req.params;
    const { date, force } = req.query;

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    const match = await findMatch(sport, matchId, date, force === 'true');

    if (!match) {
      throw new AppError(`Match not found: ${matchId}`, 404);
    }

    formatSuccess(res, {
      data: match
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Formate les courses hippiques pour l'affichage
 */
exports.formatHorseRaces = (fixtures, leagueId) => {
  const hippodrome = fixtures[0];
  
  return {
    hippodrome: {
      id: leagueId,
      name: hippodrome.league.name,
      fullName: hippodrome.venue.name,
      city: hippodrome.venue.city,
      emoji: exports.getHippodromeEmoji(leagueId)
    },
    date: fixtures[0].date.split('T')[0],
    weather: fixtures[0].sportSpecific?.weather,
    meetingType: fixtures[0].sportSpecific?.meetingType,
    races: fixtures.map(fixture => ({
      id: fixture.id,
      raceNumber: fixture.sportSpecific?.courseNumber,
      name: fixture.sportSpecific?.courseName,
      shortName: fixture.sportSpecific?.courseNameShort,
      startTime: fixture.date,
      discipline: fixture.sportSpecific?.discipline,
      distance: fixture.sportSpecific?.distance,
      track: fixture.sportSpecific?.track,
      status: exports.formatRaceStatus(fixture.status),
      runners: fixture.sportSpecific?.runners,
      conditions: fixture.sportSpecific?.conditions,
      prize: {
        total: fixture.sportSpecific?.prize?.total,
        first: fixture.sportSpecific?.prize?.first,
        second: fixture.sportSpecific?.prize?.second,
        third: fixture.sportSpecific?.prize?.third
      },
      betting: fixture.sportSpecific?.bettingTypes?.map(bet => ({
        type: bet.type,
        stake: bet.baseStake,
        available: bet.available
      })) || [],
      result: fixture.score?.details?.arrivee ? {
        finishing: fixture.score.details.arrivee,
        inquiry: fixture.score.details.enquete
      } : null,
      duration: fixture.sportSpecific?.raceDuration
    })).sort((a, b) => a.raceNumber - b.raceNumber),
    totalRaces: fixtures.length
  };
};

/**
 * Formate les détails d'une course hippique
 */
exports.formatHorseRaceDetails = (matchData) => {
  return {
    race: {
      id: matchData.id,
      number: matchData.sportSpecific?.courseNumber,
      name: matchData.sportSpecific?.courseName,
      shortName: matchData.sportSpecific?.courseNameShort,
      startTime: matchData.date,
      discipline: matchData.sportSpecific?.discipline,
      distance: matchData.sportSpecific?.distance,
      track: matchData.sportSpecific?.track,
      status: exports.formatRaceStatus(matchData.status),
      runners: matchData.sportSpecific?.runners
    },
    hippodrome: {
      id: matchData.league.id,
      name: matchData.league.name,
      fullName: matchData.venue.name,
      city: matchData.venue.city,
      emoji: exports.getHippodromeEmoji(matchData.league.id)
    },
    conditions: matchData.sportSpecific?.conditions,
    prize: matchData.sportSpecific?.prize,
    betting: matchData.sportSpecific?.bettingTypes,
    weather: matchData.sportSpecific?.weather,
    meetingType: matchData.sportSpecific?.meetingType,
    result: matchData.score?.details?.arrivee ? {
      finishing: matchData.score.details.arrivee,
      inquiry: matchData.score.details.enquete,
      duration: matchData.sportSpecific?.raceDuration
    } : null
  };
};

/**
 * Retourne un emoji pour l'hippodrome
 */
exports.getHippodromeEmoji = (hippodromeCode) => {
  const emojiMap = {
    'LSO': '🌊', // Les Sables d'Olonne - côtier
    'SSB': '🏔️', // San Sebastian - montagnard
    'LON': '🏛️', // Longchamp - parisien prestige
    'CAE': '🌾', // Caen - campagne
    'BOR': '🍷', // Bordeaux - vignoble
    'DEA': '⭐', // Deauville - prestige
    'MAR': '🏰', // Marseille - méditerranéen
    'LYO': '🦁', // Lyon - lion de la ville
    'NAN': '🏰', // Nantes - château
    'TOU': '🌸', // Toulouse - ville rose
  };
  
  return emojiMap[hippodromeCode] || '🏇'; // Emoji par défaut
};

/**
 * Formate le statut de course en français
 */
exports.formatRaceStatus = (status) => {
  const statusMap = {
    'NOT_STARTED': 'Programmée',
    'LIVE': 'En cours',
    'FINISHED': 'Terminée',
    'CANCELLED': 'Annulée'
  };
  
  return statusMap[status] || status;
};/**
 * GET /api/sports/:sport/races/:raceId/participants?date=YYYY-MM-DD
 *//**
 * GET /api/sports/:sport/races/:raceId/participants?date=YYYY-MM-DD
 */
exports.getRaceParticipants = async (req, res, next) => {
  try {
    const { sport, raceId } = req.params;
    const { date } = req.query;

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    if (sport !== 'horse') {
      throw new AppError(`Participants endpoint only available for horse racing`, 400);
    }

    if (!date) {
      throw new AppError(`Date parameter is required`, 400);
    }

    if (!raceId || !raceId.match(/^R\d+-C\d+$/)) {
      throw new AppError(`Invalid race ID format. Expected: R2-C1`, 400);
    }

    // Utiliser directement le HorseProvider
    const HorseProvider = require('../../../core/sports/providers/HorseProvider');
    const HttpClient = require('../../../utils/httpClient');
    const logger = require('../../../utils/logger');

    const horseProvider = new HorseProvider(sportsConfig.horse, {
      httpClient: new HttpClient(),
      logger
    });

    // Récupérer les participants
    const rawData = await horseProvider.fetchParticipants(date, raceId);
    const normalizedData = horseProvider.normalizeParticipants(rawData);
    
    // Ajouter l'ID de course aux données normalisées
    normalizedData.raceId = raceId;
    normalizedData.date = date;

    formatSuccess(res, {
      data: normalizedData
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/sports/:sport/races/:raceId/events?date=YYYY-MM-DD
 */
exports.getHorseEvents = async (req, res, next) => {
  try {
    const { sport, raceId } = req.params;
    const { date } = req.query;

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    if (sport !== 'horse') {
      throw new AppError(`Horse events endpoint only available for horse racing`, 400);
    }

    if (!date) {
      throw new AppError(`Date parameter is required`, 400);
    }

    // Récupérer d'abord les participants pour connaître le nombre de partants
    const HorseProvider = require('../../../core/sports/providers/HorseProvider');
    const HttpClient = require('../../../utils/httpClient');
    const logger = require('../../../utils/logger');

    const horseProvider = new HorseProvider(sportsConfig.horse, {
      httpClient: new HttpClient(),
      logger
    });

    const rawData = await horseProvider.fetchParticipants(date, raceId);
    const participantsData = horseProvider.normalizeParticipants(rawData);

    // Générer les événements disponibles selon le nombre de partants
    const events = exports.generateHorseEvents(participantsData.totalPartants, participantsData.participants);

    formatSuccess(res, {
      data: {
        raceId,
        date,
        totalPartants: participantsData.totalPartants,
        availableEvents: events
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/sports/:sport/races/:raceId/events/build?date=YYYY-MM-DD
 */
exports.buildHorseEvent = async (req, res, next) => {
  try {
    const { sport, raceId } = req.params;
    const { date } = req.query;
    const { eventType, selectedHorses, userInput } = req.body;

    if (!sportsConfig[sport]) {
      throw new AppError(`Sport not found: ${sport}`, 404);
    }

    if (sport !== 'horse') {
      throw new AppError(`Horse event building only available for horse racing`, 400);
    }

    if (!date) {
      throw new AppError(`Date parameter is required`, 400);
    }

    if (!eventType) {
      throw new AppError(`Missing required field: eventType`, 400);
    }

    // Récupérer les participants pour validation
    const HorseProvider = require('../../../core/sports/providers/HorseProvider');
    const HttpClient = require('../../../utils/httpClient');
    const logger = require('../../../utils/logger');

    const horseProvider = new HorseProvider(sportsConfig.horse, {
      httpClient: new HttpClient(),
      logger
    });

    const rawData = await horseProvider.fetchParticipants(date, raceId);
    const participantsData = horseProvider.normalizeParticipants(rawData);

    // Construire l'événement selon le type
    const builtEvent = exports.buildHorseEventFromUserInput(
      eventType, 
      selectedHorses, 
      userInput, 
      participantsData.participants, 
      participantsData.totalPartants,
      raceId
    );

    formatSuccess(res, {
      data: {
        event: builtEvent
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Génère les 4 types d'événements disponibles pour le client
 */
exports.generateHorseEvents = (totalPartants, participants) => {
  const events = [];

  // 1. Simple Placé - TOUJOURS disponible
  events.push({
    id: 'simple_place',
    type: 'simple_place',
    label: {
      fr: 'Simple Placé',
      en: 'Show Bet'
    },
    category: 'placement',
    description: {
      fr: 'Sélectionnez un cheval qui finira placé',
      en: 'Select a horse that will finish in the places'
    },
    selectionMode: 'horse_selection', // L'utilisateur sélectionne un cheval dans la liste
    available: true,
    pmuRules: {
      placesPayees: totalPartants >= 8 ? 3 : 2,
      miseBase: 1.50
    }
  });

  // 2. 2 sur 4 en Base - si >= 10 partants
  events.push({
    id: 'deux_sur_quatre_base',
    type: 'deux_sur_quatre_base',
    label: {
      fr: '2 sur 4 en Base',
      en: '2 out of 4 with Base'
    },
    category: 'combination',
    description: {
      fr: 'Saisissez votre formule (ex: 14x 5-9)',
      en: 'Enter your formula (ex: 14x 5-9)'
    },
    selectionMode: 'user_input', // L'utilisateur saisit sa formule
    available: totalPartants >= 10,
    unavailableReason: totalPartants < 10 ? 'Nécessite au moins 10 partants' : null,
    pmuRules: {
      miseBase: 3.00,
      formatExemple: '14x 5-9'
    }
  });

  // 3. Quinté en Base - si >= 8 partants
  events.push({
    id: 'quinte_base',
    type: 'quinte_base',
    label: {
      fr: 'Quinté en Base',
      en: 'Quinté with Base'
    },
    category: 'combination',
    description: {
      fr: 'Saisissez votre formule (ex: 14-5-9xx)',
      en: 'Enter your formula (ex: 14-5-9xx)'
    },
    selectionMode: 'user_input',
    available: totalPartants >= 8,
    unavailableReason: totalPartants < 8 ? 'Nécessite au moins 8 partants' : null,
    pmuRules: {
      miseBase: 2.00,
      formatExemple: '14-5-9xx'
    }
  });

  // 4. Quinté Élargi - si >= 8 partants
  events.push({
    id: 'quinte_elargi',
    type: 'quinte_elargi',
    label: {
      fr: 'Quinté Élargi',
      en: 'Quinté Extended'
    },
    category: 'combination',
    description: {
      fr: 'Saisissez vos chevaux (ex: 9-5-9-7-14-15-4-10)',
      en: 'Enter your horses (ex: 9-5-9-7-14-15-4-10)'
    },
    selectionMode: 'user_input',
    available: totalPartants >= 8,
    unavailableReason: totalPartants < 8 ? 'Nécessite au moins 8 partants' : null,
    pmuRules: {
      miseBase: 2.00,
      formatExemple: '9-5-9-7-14-15-4-10'
    }
  });

  return events;
};

/**
 * Construit un événement à partir de l'input utilisateur
 */
exports.buildHorseEventFromUserInput = (eventType, selectedHorses, userInput, participants, totalPartants, raceId) => {
  // Validation des types d'événements supportés
  const supportedEventTypes = ['simple_place', 'deux_sur_quatre_base', 'quinte_base', 'quinte_elargi'];
  if (!supportedEventTypes.includes(eventType)) {
    throw new AppError(`Type d'événement non supporté: ${eventType}. Types supportés: ${supportedEventTypes.join(', ')}`, 400);
  }

  // Validation des conditions de partants
  const validationRules = {
    'deux_sur_quatre_base': { minPartants: 10, message: '2 sur 4 en Base nécessite au moins 10 partants' },
    'quinte_base': { minPartants: 8, message: 'Quinté en Base nécessite au moins 8 partants' },
    'quinte_elargi': { minPartants: 8, message: 'Quinté Élargi nécessite au moins 8 partants' }
  };

  const rule = validationRules[eventType];
  if (rule && totalPartants < rule.minPartants) {
    throw new AppError(rule.message, 400);
  }

  // Traitement selon le type d'événement
  switch (eventType) {
    case 'simple_place':
      return exports.buildSimplePlaceEvent(selectedHorses, participants, totalPartants, raceId);
    
    case 'deux_sur_quatre_base':
      return exports.buildDeuxSurQuatreBaseEvent(userInput, participants, totalPartants, raceId);
    
    case 'quinte_base':
      return exports.buildQuinteBaseEvent(userInput, participants, totalPartants, raceId);
    
    case 'quinte_elargi':
      return exports.buildQuinteElargiEvent(userInput, participants, totalPartants, raceId);
    
    default:
      throw new AppError(`Type d'événement non géré: ${eventType}`, 400);
  }
};

/**
 * Construit un événement Simple Placé
 */
exports.buildSimplePlaceEvent = (selectedHorses, participants, totalPartants, raceId) => {
  if (!selectedHorses || selectedHorses.length !== 1) {
    throw new AppError('Simple Placé nécessite exactement 1 cheval sélectionné', 400);
  }

  const horseNumber = selectedHorses[0];
  const selectedParticipant = participants.find(p => p.numero === horseNumber);
  
  if (!selectedParticipant) {
    throw new AppError(`Cheval n°${horseNumber} introuvable dans cette course`, 400);
  }

  const placesPayees = totalPartants >= 8 ? 3 : 2;
  const placesText = totalPartants >= 8 ? "3 premiers" : "2 premiers";

  return {
    id: `simple_place_${horseNumber}_${raceId}`,
    position: 1,
    priority: 'high',
    label: {
      fr: `Simple Placé - ${selectedParticipant.nom} (${horseNumber})`,
      en: `Show Bet - ${selectedParticipant.nom} (${horseNumber})`,
      current: `Simple Placé - ${selectedParticipant.nom} (${horseNumber})`
    },
    expression: `placement_${horseNumber}_top${placesPayees}`,
    category: 'horse_racing',
    description: {
      fr: `Le cheval n°${horseNumber} (${selectedParticipant.nom}) finit dans les ${placesText}`,
      en: `Horse #${horseNumber} (${selectedParticipant.nom}) finishes in top ${placesPayees}`,
      current: `Le cheval n°${horseNumber} (${selectedParticipant.nom}) finit dans les ${placesText}`
    },
    pmuCompliant: {
      miseBase: 1.50,
      reglesPMU: true
    },
    horseSpecific: {
      raceId: raceId,
      eventType: 'simple_place',
      selectedHorse: horseNumber,
      selectedParticipant: {
        numero: selectedParticipant.numero,
        nom: selectedParticipant.nom
      },
      totalPartants: totalPartants,
      placesPayees: placesPayees
    }
  };
};

/**
 * Construit un événement 2 sur 4 en Base - FORMAT CLIENT STRICT: "14x 5-9"
 */
exports.buildDeuxSurQuatreBaseEvent = (userInput, participants, totalPartants, raceId) => {
  if (!userInput || typeof userInput !== 'string') {
    throw new AppError('2 sur 4 en Base nécessite une saisie utilisateur (ex: 14x 5-9)', 400);
  }

  // Parser UNIQUEMENT le format "14x 5-9" ou "14x5-9"
  const cleanInput = userInput.replace(/\s+/g, ''); // Supprimer les espaces
  const match = cleanInput.match(/^(\d+)x(.+)$/i);
  
  if (!match) {
    throw new AppError('Format invalide. Utilisez le format: 14x 5-9', 400);
  }

  const baseHorse = parseInt(match[1]);
  const associatedHorses = match[2].split('-').map(n => parseInt(n.trim()));

  // Validation des numéros
  const validNumbers = participants.map(p => p.numero);
  const allHorses = [baseHorse, ...associatedHorses];
  const invalidHorses = allHorses.filter(num => !validNumbers.includes(num));
  
  if (invalidHorses.length > 0) {
    throw new AppError(`Numéros de chevaux invalides: ${invalidHorses.join(', ')}. Numéros valides: ${validNumbers.join(', ')}`, 400);
  }

  // Calculer les combinaisons
  const combinaisons = associatedHorses.map(associe => [baseHorse, associe]);
  const nombreCombinaisons = combinaisons.length;

  return {
    id: `deux_sur_quatre_base_${raceId}_${baseHorse}_${associatedHorses.sort().join('_')}`,
    position: 1,
    priority: 'high',
    label: {
      fr: `2 sur 4 Base - ${userInput}`,
      en: `2 out of 4 Base - ${userInput}`,
      current: `2 sur 4 Base - ${userInput}`
    },
    expression: `deux_sur_quatre_base_${baseHorse}_${associatedHorses.sort().join('_')}`,
    category: 'horse_racing',
    description: {
      fr: `Base ${baseHorse} avec ${associatedHorses.join(', ')} - ${nombreCombinaisons} combinaison(s)`,
      en: `Base ${baseHorse} with ${associatedHorses.join(', ')} - ${nombreCombinaisons} combination(s)`,
      current: `Base ${baseHorse} avec ${associatedHorses.join(', ')} - ${nombreCombinaisons} combinaison(s)`
    },
    pmuCompliant: {
      miseBase: 3.00,
      nombreCombinaisons: nombreCombinaisons,
      coutTotal: 3.00 * nombreCombinaisons,
      reglesPMU: true,
      formatAffichageTableau: {
        ligne1: `${baseHorse}x`,
        ligne2: associatedHorses.join('-')
      }
    },
    horseSpecific: {
      raceId: raceId,
      eventType: 'deux_sur_quatre_base',
      userInput: userInput,
      baseHorse: baseHorse,
      associatedHorses: associatedHorses,
      combinaisons: combinaisons,
      totalPartants: totalPartants,
      placesPayees: 4
    }
  };
};

/**
 * Construit un événement Quinté en Base - FORMAT CLIENT STRICT: "14-5-9xx"
 */
exports.buildQuinteBaseEvent = (userInput, participants, totalPartants, raceId) => {
  if (!userInput || typeof userInput !== 'string') {
    throw new AppError('Quinté en Base nécessite une saisie utilisateur (ex: 14-5-9xx)', 400);
  }

  // Parser UNIQUEMENT le format "14-5-9xx"
  const cleanInput = userInput.trim();
  const match = cleanInput.match(/^(.+)xx$/i);
  
  if (!match) {
    throw new AppError('Format invalide. Utilisez le format: 14-5-9xx', 400);
  }

  const baseHorses = match[1].split('-').map(n => parseInt(n.trim()));

  // Validation
  const validNumbers = participants.map(p => p.numero);
  const invalidHorses = baseHorses.filter(num => !validNumbers.includes(num));
  
  if (invalidHorses.length > 0) {
    throw new AppError(`Numéros de chevaux invalides: ${invalidHorses.join(', ')}`, 400);
  }

  if (baseHorses.length < 3) {
    throw new AppError('Quinté en Base nécessite au moins 3 chevaux de base', 400);
  }

  return {
    id: `quinte_base_${raceId}_${baseHorses.sort().join('_')}`,
    position: 1,
    priority: 'high',
    label: {
      fr: `Quinté Base - ${userInput}`,
      en: `Quinté Base - ${userInput}`,
      current: `Quinté Base - ${userInput}`
    },
    expression: `quinte_base_${baseHorses.sort().join('_')}`,
    category: 'horse_racing',
    description: {
      fr: `Quinté avec base ${baseHorses.join(', ')} et champ total`,
      en: `Quinté with base ${baseHorses.join(', ')} and full field`,
      current: `Quinté avec base ${baseHorses.join(', ')} et champ total`
    },
    pmuCompliant: {
      miseBase: 2.00,
      reglesPMU: true,
      formatAffichageTableau: {
        ligne1: baseHorses.join('-') + 'xx',
        ligne2: 'CHAMP TOTAL'
      }
    },
    horseSpecific: {
      raceId: raceId,
      eventType: 'quinte_base',
      userInput: userInput,
      baseHorses: baseHorses,
      champTotal: true,
      totalPartants: totalPartants,
      placesPayees: 5
    }
  };
};

/**
 * Construit un événement Quinté Élargi - FORMAT CLIENT STRICT: "9-5-9-7-14-15-4-10"
 */
exports.buildQuinteElargiEvent = (userInput, participants, totalPartants, raceId) => {
  if (!userInput || typeof userInput !== 'string') {
    throw new AppError('Quinté Élargi nécessite une saisie utilisateur (ex: 9-5-9-7-14-15-4-10)', 400);
  }

  // Parser le format "9-5-9-7-14-15-4-10"
  const selectedHorses = userInput.split('-').map(n => parseInt(n.trim()));

  // Validation
  const validNumbers = participants.map(p => p.numero);
  const invalidHorses = selectedHorses.filter(num => !validNumbers.includes(num));
  
  if (invalidHorses.length > 0) {
    throw new AppError(`Numéros de chevaux invalides: ${invalidHorses.join(', ')}`, 400);
  }

  if (selectedHorses.length < 5) {
    throw new AppError('Quinté Élargi nécessite au moins 5 chevaux', 400);
  }

  return {
    id: `quinte_elargi_${raceId}_${selectedHorses.sort().join('_')}`,
    position: 1,
    priority: 'high',
    label: {
      fr: `Quinté Élargi - ${userInput}`,
      en: `Quinté Extended - ${userInput}`,
      current: `Quinté Élargi - ${userInput}`
    },
    expression: `quinte_elargi_${selectedHorses.sort().join('_')}`,
    category: 'horse_racing',
    description: {
      fr: `Quinté élargi avec les chevaux ${selectedHorses.join(', ')}`,
      en: `Extended Quinté with horses ${selectedHorses.join(', ')}`,
      current: `Quinté élargi avec les chevaux ${selectedHorses.join(', ')}`
    },
    pmuCompliant: {
      miseBase: 2.00,
      reglesPMU: true,
      formatAffichageTableau: {
        ligne1: selectedHorses.join('-'),
        ligne2: null // Pas de deuxième ligne pour le quinté élargi
      }
    },
    horseSpecific: {
      raceId: raceId,
      eventType: 'quinte_elargi',
      userInput: userInput,
      selectedHorses: selectedHorses,
      totalPartants: totalPartants,
      placesPayees: 5
    }
  };
};