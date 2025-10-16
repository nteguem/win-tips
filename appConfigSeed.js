/**
 * @fileoverview Seed des configurations par pays
 * Initialise les configurations pour tous les pays supportés
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AppConfig = require('./src/api/models/common/AppConfig');
const logger = require('./src/utils/logger');

/**
 * Configurations par défaut pour tous les pays
 */
const defaultConfigs = [
  // Configuration par défaut (fallback)
  {
    countryCode: 'DEFAULT',
    countryName: 'International',
    currency: 'USD',
    language: 'en',
    phonePrefix: '+1',
    paymentProvider: 'googlepay',
    isActive: true,
    metadata: {
      callingCode: '1',
      region: 'Other',
      timezone: 'UTC',
    },
  },

  // === AFRIQUE CENTRALE ===
  {
    countryCode: 'CM',
    countryName: 'Cameroun',
    currency: 'XAF',
    language: 'fr',
    phonePrefix: '+237',
    paymentProvider: 'cinetpay',
    isActive: true,
    metadata: {
      callingCode: '237',
      region: 'Central Africa',
      timezone: 'Africa/Douala',
    },
  },
  {
    countryCode: 'GA',
    countryName: 'Gabon',
    currency: 'XAF',
    language: 'fr',
    phonePrefix: '+241',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '241',
      region: 'Central Africa',
      timezone: 'Africa/Libreville',
    },
  },
  {
    countryCode: 'CG',
    countryName: 'Congo',
    currency: 'XAF',
    language: 'fr',
    phonePrefix: '+242',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '242',
      region: 'Central Africa',
      timezone: 'Africa/Brazzaville',
    },
  },
  {
    countryCode: 'CD',
    countryName: 'RD Congo',
    currency: 'CDF',
    language: 'fr',
    phonePrefix: '+243',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '243',
      region: 'Central Africa',
      timezone: 'Africa/Kinshasa',
    },
  },
  {
    countryCode: 'CF',
    countryName: 'Centrafrique',
    currency: 'XAF',
    language: 'fr',
    phonePrefix: '+236',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '236',
      region: 'Central Africa',
      timezone: 'Africa/Bangui',
    },
  },
  {
    countryCode: 'TD',
    countryName: 'Tchad',
    currency: 'XAF',
    language: 'fr',
    phonePrefix: '+235',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '235',
      region: 'Central Africa',
      timezone: 'Africa/Ndjamena',
    },
  },

  // === AFRIQUE DE L'OUEST ===
  {
    countryCode: 'CI',
    countryName: 'Côte d\'Ivoire',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+225',
    paymentProvider: 'cinetpay',
    isActive: true,
    metadata: {
      callingCode: '225',
      region: 'West Africa',
      timezone: 'Africa/Abidjan',
    },
  },
  {
    countryCode: 'SN',
    countryName: 'Sénégal',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+221',
    paymentProvider: 'cinetpay',
    isActive: true,
    metadata: {
      callingCode: '221',
      region: 'West Africa',
      timezone: 'Africa/Dakar',
    },
  },
  {
    countryCode: 'ML',
    countryName: 'Mali',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+223',
    paymentProvider: 'cinetpay',
    isActive: true,
    metadata: {
      callingCode: '223',
      region: 'West Africa',
      timezone: 'Africa/Bamako',
    },
  },
  {
    countryCode: 'BF',
    countryName: 'Burkina Faso',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+226',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '226',
      region: 'West Africa',
      timezone: 'Africa/Ouagadougou',
    },
  },
  {
    countryCode: 'NE',
    countryName: 'Niger',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+227',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '227',
      region: 'West Africa',
      timezone: 'Africa/Niamey',
    },
  },
  {
    countryCode: 'TG',
    countryName: 'Togo',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+228',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '228',
      region: 'West Africa',
      timezone: 'Africa/Lome',
    },
  },
  {
    countryCode: 'BJ',
    countryName: 'Bénin',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+229',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '229',
      region: 'West Africa',
      timezone: 'Africa/Porto-Novo',
    },
  },
  {
    countryCode: 'GN',
    countryName: 'Guinée',
    currency: 'GNF',
    language: 'fr',
    phonePrefix: '+224',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '224',
      region: 'West Africa',
      timezone: 'Africa/Conakry',
    },
  },
  {
    countryCode: 'GW',
    countryName: 'Guinée-Bissau',
    currency: 'XOF',
    language: 'fr',
    phonePrefix: '+245',
    paymentProvider: 'afribapay',
    isActive: true,
    metadata: {
      callingCode: '245',
      region: 'West Africa',
      timezone: 'Africa/Bissau',
    },
  },

  // === EUROPE ===
  {
    countryCode: 'FR',
    countryName: 'France',
    currency: 'EUR',
    language: 'fr',
    phonePrefix: '+33',
    paymentProvider: 'googlepay',
    isActive: true,
    metadata: {
      callingCode: '33',
      region: 'Europe',
      timezone: 'Europe/Paris',
    },
  },
  {
    countryCode: 'BE',
    countryName: 'Belgique',
    currency: 'EUR',
    language: 'fr',
    phonePrefix: '+32',
    paymentProvider: 'googlepay',
    isActive: true,
    metadata: {
      callingCode: '32',
      region: 'Europe',
      timezone: 'Europe/Brussels',
    },
  },
  {
    countryCode: 'CH',
    countryName: 'Suisse',
    currency: 'EUR',
    language: 'fr',
    phonePrefix: '+41',
    paymentProvider: 'googlepay',
    isActive: true,
    metadata: {
      callingCode: '41',
      region: 'Europe',
      timezone: 'Europe/Zurich',
    },
  },
];

/**
 * Seed les configurations dans la base de données
 */
async function seedAppConfigs() {
  try {
    logger.info('[Seed] Début du seed des configurations...');

    // Compter les configs existantes
    const existingCount = await AppConfig.countDocuments();
    logger.info(`[Seed] ${existingCount} configurations existantes trouvées`);

    // Insérer ou mettre à jour chaque configuration
    let created = 0;
    let updated = 0;

    for (const config of defaultConfigs) {
      const existing = await AppConfig.findOne({ countryCode: config.countryCode });

      if (existing) {
        // Mettre à jour si existe déjà
        await AppConfig.findOneAndUpdate(
          { countryCode: config.countryCode },
          config,
          { new: true }
        );
        updated++;
        logger.info(`[Seed] Configuration mise à jour: ${config.countryCode} - ${config.countryName}`);
      } else {
        // Créer si n'existe pas
        await AppConfig.create(config);
        created++;
        logger.info(`[Seed] Configuration créée: ${config.countryCode} - ${config.countryName}`);
      }
    }

    logger.info('[Seed] ✅ Seed terminé avec succès !');
    logger.info(`[Seed] Résumé: ${created} créées, ${updated} mises à jour`);
    logger.info(`[Seed] Total: ${await AppConfig.countDocuments()} configurations dans la DB`);
  } catch (error) {
    logger.error(`[Seed] ❌ Erreur lors du seed: ${error.message}`);
    throw error;
  }
}

/**
 * Supprimer toutes les configurations (pour reset)
 */
async function clearAppConfigs() {
  try {
    logger.info('[Seed] Suppression de toutes les configurations...');
    const result = await AppConfig.deleteMany({});
    logger.info(`[Seed] ${result.deletedCount} configurations supprimées`);
  } catch (error) {
    logger.error(`[Seed] Erreur lors de la suppression: ${error.message}`);
    throw error;
  }
}

// Export des fonctions
module.exports = {
  seedAppConfigs,
  clearAppConfigs,
  defaultConfigs,
};

// Exécution standalone si appelé directement
if (require.main === module) {
  const { connectDB } = require('./config/database'); // ← CORRECTION ICI

  (async () => {
    try {
      // Connexion à la DB
      await connectDB(); // ← CORRECTION ICI
      logger.info('[Seed] Connecté à MongoDB');

      // Exécuter le seed
      await seedAppConfigs();

      // Fermer la connexion
      await mongoose.connection.close();
      logger.info('[Seed] Connexion fermée');
      process.exit(0);
    } catch (error) {
      logger.error(`[Seed] Erreur fatale: ${error.message}`);
      process.exit(1);
    }
  })();
}