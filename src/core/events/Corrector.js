/**
 * @fileoverview Moteur unifié de correction des prédictions
 * Remplace : CorrectionEngine, footballCorrector, ExpressionEvaluator, EventValidator
 */

const EventManager = require('./EventManager');

class Corrector {
  constructor() {
    this.eventManager = new EventManager();
  }

  /**
   * Corrige une prédiction unique
   */
  correctPrediction(prediction, matchData, sport = 'football') {
    const result = {
      success: false,
      prediction: {
        id: prediction?.id || null,
        eventId: prediction?.event?.id || null
      },
      match: {
        id: matchData?.id || null,
        sport: sport
      },
      correction: {
        canCorrect: false,
        result: null,
        confidence: 'unknown',
        reason: null
      },
      evaluation: null,
      timestamp: new Date().toISOString()
    };

    try {
      // 1. Validation rapide
      const validation = this.validateForCorrection(prediction, matchData);
      if (!validation.valid) {
        result.correction.reason = validation.reason;
        return result;
      }

      // 2. Construire l'événement si nécessaire
      let event = prediction.event;
      if (event.parametric && !event.expression) {
        const buildResult = this.eventManager.buildEvent(sport, event.id, event.params);
        if (!buildResult.success) {
          result.correction.reason = `Erreur construction: ${buildResult.error}`;
          return result;
        }
        event = buildResult.event;
      }

      // 3. Évaluation de l'expression
      const evaluation = this.evaluateExpression(event.expression, matchData, sport);
      result.evaluation = evaluation;

      if (!evaluation.success) {
        result.correction.reason = `Erreur évaluation: ${evaluation.error}`;
        return result;
      }

      // 4. Résultat de correction
      result.success = true;
      result.correction = {
        canCorrect: true,
        result: evaluation.value,
        confidence: this.calculateConfidence(matchData, sport),
        reason: this.generateReason(event, evaluation.value, matchData),
        expression: event.expression
      };

    } catch (error) {
      result.correction.reason = `Erreur interne: ${error.message}`;
    }

    return result;
  }

  /**
   * Corrige plusieurs prédictions en batch
   */
  correctMultiple(predictions, matchData, sport = 'football') {
    const results = {
      total: predictions.length,
      success: 0,
      failed: 0,
      results: [],
      summary: {
        sport: sport,
        matchId: matchData?.id || null,
        matchStatus: matchData?.status || 'unknown',
        timestamp: new Date().toISOString()
      }
    };

    if (!Array.isArray(predictions) || predictions.length === 0) {
      results.summary.error = 'Aucune prédiction fournie';
      return results;
    }

    predictions.forEach((prediction, index) => {
      const correctionResult = this.correctPrediction(prediction, matchData, sport);
      
      results.results.push({
        index: index,
        predictionId: prediction?.id || null,
        ...correctionResult
      });

      if (correctionResult.success && correctionResult.correction.canCorrect) {
        results.success++;
      } else {
        results.failed++;
      }
    });

    results.summary.successRate = results.total > 0 ? 
      ((results.success / results.total) * 100).toFixed(1) : 0;

    return results;
  }

  /**
   * Validation rapide pour correction
   */
  validateForCorrection(prediction, matchData) {
    // Données de base
    if (!prediction?.event?.id) {
      return { valid: false, reason: 'Événement manquant ou sans ID' };
    }

    if (!matchData) {
      return { valid: false, reason: 'Données de match manquantes' };
    }

    // Statut du match
    if (matchData.status !== 'FINISHED' && matchData.status !== 'FT') {
      return { valid: false, reason: `Match non terminé (statut: ${matchData.status})` };
    }

    // Score disponible
    if (matchData.score?.home === undefined || matchData.score?.away === undefined) {
      return { valid: false, reason: 'Score du match manquant' };
    }

    return { valid: true };
  }

  /**
   * Évalue une expression avec les données du match
   */
  evaluateExpression(expression, matchData, sport) {
    const result = {
      success: false,
      value: null,
      error: null,
      expression: expression
    };

    try {
      // Validation de sécurité
      if (!this.isSafeExpression(expression)) {
        console.log("expression",expression)
        result.error = 'Expression non autorisée';
        return result;
      }

      // Créer le contexte d'évaluation
      const context = this.createContext(matchData, sport);
      
      // Évaluation sécurisée
      const func = new Function(...Object.keys(context), `return ${expression}`);
      result.value = func(...Object.values(context));
      result.success = true;

    } catch (error) {
      result.error = error.message;
    }

    return result;
  }

  /**
   * Vérifie la sécurité d'une expression
   */
  isSafeExpression(expression) {
    // Vérifier que expression existe et est une string
    if (!expression || typeof expression !== 'string') {
      return false;
    }

    // Caractères autorisés : variables, opérateurs, nombres avec décimales, parenthèses
    const allowedPattern = /^[a-zA-Z0-9\s\.\>\<\=\!\+\-\*\/\(\)\|\&_]+$/;
    
    if (!allowedPattern.test(expression)) {
      console.log('❌ Expression rejected by pattern:', expression);
      return false;
    }

    // Mots-clés interdits
    const forbidden = ['eval', 'Function', 'constructor', 'import', 'require', 'process', 'window', 'document'];
    const hasForbidden = forbidden.some(keyword => expression.includes(keyword));
    
    if (hasForbidden) {
      console.log('❌ Expression contains forbidden keyword:', expression);
      return false;
    }

    console.log('✅ Expression is safe:', expression);
    return true;
  }

  /**
   * Crée le contexte d'évaluation selon le sport
   */
  createContext(matchData, sport) {
    const score = matchData.score || {};
    
    // Contexte de base (tous sports)
    const baseContext = {
      // Scores principaux
      score: {
        home: score.home || 0,
        away: score.away || 0,
        details: score.details || {}
      },
      
      // Variables calculées communes
      totalGoals: (score.home || 0) + (score.away || 0),
      homeWins: (score.home || 0) > (score.away || 0),
      awayWins: (score.away || 0) > (score.home || 0),
      draw: (score.home || 0) === (score.away || 0),
      bothTeamsScore: (score.home || 0) > 0 && (score.away || 0) > 0,
      
      // Métadonnées
      status: matchData.status
    };

    // Contexte spécifique par sport
    switch (sport.toLowerCase()) {
      case 'football':
        return { ...baseContext, ...this.createFootballContext(matchData) };
      
      case 'basketball':
        return { ...baseContext, ...this.createBasketballContext(matchData) };
      
      case 'volleyball':
        return { ...baseContext, ...this.createVolleyballContext(matchData) };
      
      case 'tennis':
        return { ...baseContext, ...this.createTennisContext(matchData) };
      
      case 'rugby':
        return { ...baseContext, ...this.createRugbyContext(matchData) };
      
      case 'handball':
        return { ...baseContext, ...this.createHandballContext(matchData) };
      
      case 'hockey':
        return { ...baseContext, ...this.createHockeyContext(matchData) };
      
      case 'baseball':
        return { ...baseContext, ...this.createBaseballContext(matchData) };
      
      default:
        return baseContext;
    }
  }

  /**
   * Contexte spécifique football
   */
  createFootballContext(matchData) {
    const score = matchData.score || {};
    const halftime = score.details?.halftime || { home: 0, away: 0 };
    
    const totalGoalsHT = (halftime.home || 0) + (halftime.away || 0);
    const totalGoals = (score.home || 0) + (score.away || 0);
    
    return {
      // Mi-temps
      totalGoalsHT: totalGoalsHT,
      secondHalfGoals: totalGoals - totalGoalsHT,
      
      // Nouveaux : Buts par équipe et par mi-temps
      secondHalfGoalsHome: (score.home || 0) - (halftime.home || 0),
      secondHalfGoalsAway: (score.away || 0) - (halftime.away || 0),
      
      // Variables spéciales football
      noGoals: totalGoals === 0,
      bothTeamsScoreHT: (halftime.home || 0) > 0 && (halftime.away || 0) > 0,
      
      // Temps de jeu
      elapsed: matchData.sportSpecific?.elapsed || null
    };
  }

  /**
   * Contexte spécifique basketball
   */
  createBasketballContext(matchData) {
    const score = matchData.score || {};
    const details = score.details || {};
    
    return {
      // Points par quarter
      firstHalfHome: (details.home?.quarter_1 || 0) + (details.home?.quarter_2 || 0),
      firstHalfAway: (details.away?.quarter_1 || 0) + (details.away?.quarter_2 || 0),
      secondHalfHome: (details.home?.quarter_3 || 0) + (details.home?.quarter_4 || 0),
      secondHalfAway: (details.away?.quarter_3 || 0) + (details.away?.quarter_4 || 0),
      
      // Prolongation
      hasOvertime: (details.home?.overtime || 0) > 0 || (details.away?.overtime || 0) > 0,
      
      // Totaux
      totalPoints: (score.home || 0) + (score.away || 0)
    };
  }

  /**
   * Contexte spécifique volleyball
   */
  createVolleyballContext(matchData) {
    const score = matchData.score || {};
    
    return {
      // Sets gagnés
      setsWonHome: score.home || 0,
      setsWonAway: score.away || 0,
      totalSets: (score.home || 0) + (score.away || 0),
      
      // Durée du match
      wentToFive: (score.home || 0) + (score.away || 0) === 5,
      straightSets: (score.home === 3 && score.away === 0) || (score.away === 3 && score.home === 0)
    };
  }

  /**
   * Contexte spécifique tennis
   */
  createTennisContext(matchData) {
    const score = matchData.score || {};
    
    return {
      // Sets gagnés
      setsWonHome: score.home || 0,
      setsWonAway: score.away || 0,
      totalSets: (score.home || 0) + (score.away || 0),
      
      // Durée
      straightSets: (score.home >= 2 && score.away === 0) || (score.away >= 2 && score.home === 0)
    };
  }

  /**
   * Contexte spécifique rugby
   */
  createRugbyContext(matchData) {
    const score = matchData.score || {};
    const details = score.details || {};
    
    return {
      // Mi-temps
      firstHalfTotal: (details.home?.first_half || 0) + (details.away?.first_half || 0),
      secondHalfTotal: (details.home?.second_half || 0) + (details.away?.second_half || 0),
      
      // Prolongations
      hasOvertime: (details.home?.overtime || 0) > 0 || (details.away?.overtime || 0) > 0,
      
      // Totaux
      totalPoints: (score.home || 0) + (score.away || 0)
    };
  }

  /**
   * Contexte spécifique handball
   */
  createHandballContext(matchData) {
    const score = matchData.score || {};
    const details = score.details || {};
    
    return {
      // Mi-temps
      firstHalfTotal: (details.home?.first_half || 0) + (details.away?.first_half || 0),
      secondHalfTotal: (details.home?.second_half || 0) + (details.away?.second_half || 0),
      
      // Totaux
      totalGoals: (score.home || 0) + (score.away || 0)
    };
  }

  /**
   * Contexte spécifique hockey
   */
  createHockeyContext(matchData) {
    const score = matchData.score || {};
    const details = score.details || {};
    
    return {
      // Périodes
      regulationGoalsHome: (details.home?.first_period || 0) + (details.home?.second_period || 0) + (details.home?.third_period || 0),
      regulationGoalsAway: (details.away?.first_period || 0) + (details.away?.second_period || 0) + (details.away?.third_period || 0),
      
      // Prolongations/Penalties
      hasOvertime: (details.home?.overtime || 0) > 0 || (details.away?.overtime || 0) > 0,
      hasPenalties: (details.home?.penalties || 0) > 0 || (details.away?.penalties || 0) > 0,
      
      // Totaux
      totalGoals: (score.home || 0) + (score.away || 0)
    };
  }

  /**
   * Contexte spécifique baseball
   */
  createBaseballContext(matchData) {
    const score = matchData.score || {};
    const details = score.details || {};
    
    return {
      // Statistiques
      totalRuns: (score.home || 0) + (score.away || 0),
      totalHits: (details.home?.hits || 0) + (details.away?.hits || 0),
      totalErrors: (details.home?.errors || 0) + (details.away?.errors || 0),
      
      // Performance
      hitRatio: (details.home?.hits || 0) / Math.max(1, details.home?.at_bats || 1)
    };
  }

  /**
   * Calcule le niveau de confiance
   */
  calculateConfidence(matchData, sport) {
    // Logique simple de confiance
    if (matchData.status === 'FINISHED' && matchData.score?.details) {
      return 'high';
    } else if (matchData.status === 'FINISHED') {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Génère une raison explicative
   */
  generateReason(event, result, matchData) {
    const resultText = result ? 'réussie' : 'échouée';
    const homeScore = matchData.score?.home || 0;
    const awayScore = matchData.score?.away || 0;
    
    let reason = `Prédiction ${resultText}`;
    
    if (event.label?.current) {
      reason += ` - "${event.label.current}"`;
    } else if (typeof event.label === 'string') {
      reason += ` - "${event.label}"`;
    }
    
    reason += ` (Score final: ${homeScore}-${awayScore})`;
    
    return reason;
  }

  /**
   * Test d'une expression (pour debug)
   */
  testExpression(expression, sport = 'football') {
    // Données d'exemple selon le sport
    const sampleData = {
      football: {
        id: "test",
        status: "FINISHED",
        score: {
          home: 2, away: 1,
          details: { halftime: { home: 1, away: 0 } }
        }
      },
      basketball: {
        id: "test",
        status: "FINISHED", 
        score: {
          home: 85, away: 78,
          details: {
            home: { quarter_1: 20, quarter_2: 25, quarter_3: 22, quarter_4: 18 },
            away: { quarter_1: 18, quarter_2: 20, quarter_3: 20, quarter_4: 20 }
          }
        }
      },
      volleyball: {
        id: "test",
        status: "FINISHED",
        score: { home: 3, away: 1 }
      }
    };

    const testData = sampleData[sport] || sampleData.football;
    return this.evaluateExpression(expression, testData, sport);
  }
}

module.exports = Corrector;