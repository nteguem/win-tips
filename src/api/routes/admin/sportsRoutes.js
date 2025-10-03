/**
 * @fileoverview Routes pour les sports
 */
const express = require('express');
const sportsController = require('../../controllers/admin/sportsController');

const router = express.Router();

// Liste des sports disponibles
router.get('/', sportsController.getAllSports);

// Pays disponibles pour un sport à une date
router.get('/:sport/dates/:date/countries', sportsController.getCountries);

// Ligues disponibles dans un pays à une date
router.get('/:sport/dates/:date/countries/:country/leagues', sportsController.getLeagues);

// Matchs d'une ligue dans un pays à une date
router.get('/:sport/dates/:date/countries/:country/leagues/:league/fixtures', sportsController.getFixtures);

// Détail d’un match spécifique (option ?date=)
router.get('/:sport/matches/:matchId', sportsController.getMatchDetails);

//special route course hippique 
// Participants d'une course
router.get('/:sport/races/:raceId/participants', sportsController.getRaceParticipants);

// Événements disponibles pour une course
router.get('/:sport/races/:raceId/events', sportsController.getHorseEvents);

// Construire un événement avec sélection
router.post('/:sport/races/:raceId/events/build', sportsController.buildHorseEvent);

module.exports = router;
