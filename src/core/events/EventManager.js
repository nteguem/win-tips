/**
 * @fileoverview Gestionnaire unifié des événements sportifs
 * Remplace : EventLoader, eventDefinitions, eventBuilder
 */

const fs = require('fs');
const path = require('path');

class EventManager {
  constructor() {
    this.eventsCache = new Map();
    this.sportsDir = path.join(__dirname, 'sports');
    this.loadAllSports();
  }

  /**
   * Charge automatiquement tous les sports configurés
   */
  loadAllSports() {
    try {
      console.log(`🔍 Looking for sports in: ${this.sportsDir}`);
      
      if (!fs.existsSync(this.sportsDir)) {
        console.log(`📁 Creating sports directory: ${this.sportsDir}`);
        fs.mkdirSync(this.sportsDir, { recursive: true });
      }

      const sports = fs.readdirSync(this.sportsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      console.log(`📋 Found sport directories:`, sports);

      sports.forEach(sport => {
        console.log(`🔄 Loading sport: ${sport}`);
        this.loadSport(sport);
      });

      console.log(`✅ Successfully loaded events ${this.eventsCache.size} sports:`, Array.from(this.eventsCache.keys()));

    } catch (error) {
      console.error('❌ Error loading sports:', error.message);
      console.error('Stack:', error.stack);
    }
  }

  /**
   * Charge la configuration d'un sport
   */
  loadSport(sport) {
    try {
      const configPath = path.join(this.sportsDir, sport, 'events.json');
      
      console.log(`🔍 Checking events for ${sport} at:`, configPath);
      
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        
        console.log(`✅ Loaded ${sport} events:`, {
          staticEvents: config.staticEvents?.length || 0,
          parametricEvents: config.parametricEvents?.length || 0,
          categories: Object.keys(config.categories || {}).length
        });
        
        // Trier par position
        config.staticEvents?.sort((a, b) => a.position - b.position);
        config.parametricEvents?.sort((a, b) => a.position - b.position);
        
        this.eventsCache.set(sport, config);
        return true;
      } else {
        console.log(`❌ File not found: ${configPath}`);
      }
      
      return false;
    } catch (error) {
      console.error(`❌ Failed to load ${sport} events:`, error.message);
      console.error('Stack:', error.stack);
      return false;
    }
  }

  /**
   * Vérifie si un sport est configuré
   */
  isSportConfigured(sport) {
    return this.eventsCache.has(sport);
  }

  /**
   * Obtient tous les événements d'un sport
   */
  getEvents(sport, locale = 'fr') {
    const config = this.eventsCache.get(sport);
    
    if (!config) {
      return {
        configured: false,
        message: `Sport ${sport} non configuré`,
        data: { static: [], parametric: [] },
        meta: { totalEvents: 0, totalStatic: 0, totalParametric: 0 }
      };
    }

    const staticEvents = (config.staticEvents || []).map(event => 
      this.formatStaticEvent(event, locale)
    );

    const parametricEvents = (config.parametricEvents || []).map(event => 
      this.formatParametricTemplate(event, locale)
    );

    return {
      configured: true,
      data: {
        static: staticEvents,
        parametric: parametricEvents
      },
      meta: {
        totalEvents: staticEvents.length + parametricEvents.length,
        totalStatic: staticEvents.length,
        totalParametric: parametricEvents.length,
        locale: locale
      }
    };
  }

  /**
   * Obtient les événements groupés par catégorie
   */
  getEventsByCategory(sport, locale = 'fr') {
    const config = this.eventsCache.get(sport);
    
    if (!config) {
      return {
        configured: false,
        message: `Sport ${sport} non configuré`,
        data: {},
        categories: {}
      };
    }

    const allEvents = [
      ...(config.staticEvents || []).map(e => this.formatStaticEvent(e, locale)),
      ...(config.parametricEvents || []).map(e => this.formatParametricTemplate(e, locale))
    ];

    // Grouper par catégorie
    const grouped = {};
    const categories = config.categories || {};

    Object.keys(categories).forEach(categoryKey => {
      grouped[categoryKey] = {
        name: {
          fr: categories[categoryKey].fr,
          en: categories[categoryKey].en,
          current: categories[categoryKey][locale] || categories[categoryKey].fr
        },
        events: allEvents
          .filter(event => event.category === categoryKey)
          .sort((a, b) => a.position - b.position)
      };
    });

    return {
      configured: true,
      data: grouped,
      categories: Object.keys(categories).reduce((acc, key) => {
        acc[key] = {
          fr: categories[key].fr,
          en: categories[key].en,
          current: categories[key][locale] || categories[key].fr
        };
        return acc;
      }, {})
    };
  }

  /**
   * Construit un événement (statique ou paramétrique)
   */
  buildEvent(sport, eventId, params = {}, locale = 'fr') {
    const config = this.eventsCache.get(sport);
    
    if (!config) {
      throw new Error(`Sport ${sport} non configuré`);
    }

    // Chercher l'événement
    const staticEvent = config.staticEvents?.find(e => e.id === eventId);
    const parametricEvent = config.parametricEvents?.find(e => e.id === eventId);
    
    const event = staticEvent || parametricEvent;
    
    if (!event) {
      throw new Error(`Événement ${eventId} introuvable pour ${sport}`);
    }

    // Si statique, retourner directement
    if (staticEvent) {
      return {
        success: true,
        event: this.formatStaticEvent(event, locale),
        warnings: []
      };
    }

    // Si paramétrique, construire avec les paramètres
    return this.buildParametricEvent(parametricEvent, params, locale);
  }

  /**
   * Valide qu'un événement existe
   */
  validateEvent(sport, eventId) {
    const config = this.eventsCache.get(sport);
    
    if (!config) {
      return {
        valid: false,
        exists: false,
        error: `Sport ${sport} non configuré`
      };
    }

    const allEvents = [
      ...(config.staticEvents || []),
      ...(config.parametricEvents || [])
    ];

    const event = allEvents.find(e => e.id === eventId);
    
    if (!event) {
      return {
        valid: false,
        exists: false,
        error: `Événement ${eventId} introuvable`
      };
    }

    return {
      valid: true,
      exists: true,
      eventInfo: {
        id: event.id,
        parametric: !!event.parametric,
        category: event.category,
        priority: event.priority
      }
    };
  }

  /**
   * Formate un événement statique
   */
  formatStaticEvent(event, locale) {
    return {
      id: event.id,
      position: event.position,
      priority: event.priority,
      label: {
        fr: event.label.fr,
        en: event.label.en,
        current: event.label[locale] || event.label.fr
      },
      expression: event.expression,
      category: event.category,
      description: {
        fr: event.description.fr,
        en: event.description.en,
        current: event.description[locale] || event.description.fr
      },
      parametric: false
    };
  }

  /**
   * Formate un template d'événement paramétrique
   */
  formatParametricTemplate(event, locale) {
    return {
      id: event.id,
      position: event.position,
      priority: event.priority,
      labelTemplate: {
        fr: event.labelTemplate.fr,
        en: event.labelTemplate.en,
        current: event.labelTemplate[locale] || event.labelTemplate.fr
      },
      expressionTemplate: event.expressionTemplate,
      category: event.category,
      description: {
        fr: event.description.fr,
        en: event.description.en,
        current: event.description[locale] || event.description.fr
      },
      paramFields: (event.paramFields || []).map(field => ({
        ...field,
        label: {
          fr: field.label.fr,
          en: field.label.en,
          current: field.label[locale] || field.label.fr
        },
        options: field.options?.map(option => ({
          ...option,
          label: {
            fr: option.label.fr,
            en: option.label.en,
            current: option.label[locale] || option.label.fr
          }
        }))
      })),
      parametric: true
    };
  }

  /**
   * Construit un événement paramétrique
   */
  buildParametricEvent(template, params, locale) {
    // Validation des paramètres
    const validation = this.validateParameters(template, params);
    
    if (!validation.valid) {
      throw new Error(`Paramètres invalides: ${validation.errors.join(', ')}`);
    }

    // Fusion avec les valeurs par défaut
    const finalParams = this.mergeWithDefaults(template.paramFields, params);

    // Construction du label et de l'expression
    const labelFr = this.buildLabel(template.labelTemplate.fr, finalParams, 'fr');
    const labelEn = this.buildLabel(template.labelTemplate.en, finalParams, 'en');
    const label = locale === 'en' ? labelEn : labelFr;

    return {
      success: true,
      event: {
        id: template.id,
        position: template.position,
        priority: template.priority,
        label: {
          fr: labelFr,
          en: labelEn,
          current: label
        },
        expression: this.buildExpression(template.expressionTemplate, finalParams),
        category: template.category,
        description: {
          fr: template.description.fr,
          en: template.description.en,
          current: template.description[locale] || template.description.fr
        },
        parametric: true,
        params: finalParams
      },
      warnings: validation.warnings
    };
  }

  /**
   * Valide les paramètres d'un événement paramétrique
   */
  validateParameters(template, params) {
    const result = { valid: true, errors: [], warnings: [] };

    if (!template.paramFields) {
      result.errors.push('Template sans champs de paramètres');
      result.valid = false;
      return result;
    }

    template.paramFields.forEach(field => {
      const value = params[field.name];

      if (value === undefined || value === null) {
        if (field.default !== undefined) {
          result.warnings.push(`Paramètre ${field.name} manquant, valeur par défaut utilisée: ${field.default}`);
        } else {
          result.errors.push(`Paramètre requis manquant: ${field.name}`);
          result.valid = false;
        }
        return;
      }

      // Validation par type
      if (field.type === 'number') {
        const numValue = parseFloat(value);
        if (isNaN(numValue)) {
          result.errors.push(`${field.name} doit être un nombre`);
          result.valid = false;
        } else {
          if (field.min !== undefined && numValue < field.min) {
            result.errors.push(`${field.name} doit être >= ${field.min}`);
            result.valid = false;
          }
          if (field.max !== undefined && numValue > field.max) {
            result.errors.push(`${field.name} doit être <= ${field.max}`);
            result.valid = false;
          }
        }
      } else if (field.type === 'enum') {
        const validOptions = field.options?.map(opt => opt.value) || [];
        if (!validOptions.includes(value)) {
          result.errors.push(`${field.name} doit être: ${validOptions.join(', ')}`);
          result.valid = false;
        }
      }
    });

    return result;
  }

  /**
   * Fusionne les paramètres avec les valeurs par défaut
   */
  mergeWithDefaults(paramFields, userParams) {
    const finalParams = { ...userParams };

    paramFields.forEach(field => {
      if (finalParams[field.name] === undefined && field.default !== undefined) {
        finalParams[field.name] = field.default;
      }
    });

    return finalParams;
  }

  /**
   * Construit le label avec les paramètres
   */
  buildLabel(labelTemplate, params, locale) {
    let label = labelTemplate;

    // Mappings spéciaux pour direction EN PREMIER
    if (params.direction) {
      const directionLabels = {
        fr: { over: 'Plus', under: 'Moins', equal: 'Exactement', greater: 'Plus', less: 'Moins' },
        en: { over: 'Over', under: 'Under', equal: 'Exactly', greater: 'More than', less: 'Less than' }
      };
      
      const directionText = directionLabels[locale]?.[params.direction] || params.direction;
      label = label.replace(/{{direction}}/g, directionText);
    }

    // Mappings spéciaux pour team
    if (params.team) {
      const teamLabels = {
        fr: { home: 'Domicile', away: 'Extérieur' },
        en: { home: 'Home', away: 'Away' }
      };
      
      const teamText = teamLabels[locale]?.[params.team] || params.team;
      label = label.replace(/{{team}}/g, teamText);
    }

    // Remplacements directs APRÈS les mappings spéciaux
    Object.entries(params).forEach(([key, value]) => {
      // Ignorer direction et team car déjà traités
      if (key !== 'direction' && key !== 'team') {
        label = label.replace(new RegExp(`{{${key}}}`, 'g'), value);
      }
    });

    return label;
  }

  /**
   * Construit l'expression avec les paramètres
   */
  buildExpression(expressionTemplate, params) {
    let expression = expressionTemplate;

    // Remplacements directs
    Object.entries(params).forEach(([key, value]) => {
      const placeholder = `{{${key}}}`;
      expression = expression.replace(new RegExp(placeholder, 'g'), value);
    });

    // Mapping spécial direction → operator
    if (params.direction) {
      const operatorMap = {
        over: '>', under: '<', equal: '===', not_equal: '!==',
        greater: '>', less: '<', greater_equal: '>=', less_equal: '<='
      };
      
      const operator = operatorMap[params.direction];
      if (operator) {
        expression = expression.replace(/{{operator}}/g, operator);
      }
    }

    return expression;
  }

  /**
   * Recharge un sport (utile pour le développement)
   */
  reloadSport(sport) {
    this.eventsCache.delete(sport);
    return this.loadSport(sport);
  }

  /**
   * Obtient les sports configurés
   */
  getConfiguredSports() {
    return Array.from(this.eventsCache.keys());
  }

  /**
   * Debug info
   */
  getDebugInfo() {
    return {
      configuredSports: this.getConfiguredSports(),
      sportsDir: this.sportsDir,
      cacheSize: this.eventsCache.size
    };
  }
}

module.exports = EventManager;