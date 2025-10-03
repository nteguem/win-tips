/**
 * @fileoverview Point d'entrée de l'application
 */
const dotenv = require('dotenv');
const app = require('./src/app');
const logger = require('./src/utils/logger');
const { connectDB } = require('./config/database');

// Services CRON
const PredictionCronService = require('./src/api/services/common/predictionCorrectionService');
const DataRefreshService = require('./src/api/services/common/dataRefreshService');
const googlePlayJobs = require('./src/jobs/googlePlaySyncJob');

// Chargement des variables d'environnement
dotenv.config();

const PORT = process.env.PORT || 4000;

// Instances des services
let cronService = null;
let refreshService = null;

/**
 * Démarre le serveur après initialisation
 */
const startServer = async () => {
  try {
    // Connexion à la base de données
    await connectDB();

    // Service de correction des prédictions
    cronService = new PredictionCronService();
    await cronService.start();

    // Service de mise à jour des données sportives
    refreshService = new DataRefreshService();
    await refreshService.start();

    await googlePlayJobs.start();

    // Démarrer le serveur HTTP
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server started and listening on port ${PORT}`);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

/**
 * Gestion des signaux d'arrêt
 */
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');

  if (cronService) {
    await cronService.stop();
  }
  if (refreshService) {
    await refreshService.stop();
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');

  if (cronService) {
    await cronService.stop();
  }
  if (refreshService) {
    await refreshService.stop();
  }

  process.exit(0);
});

// Démarrer le serveur
startServer();
